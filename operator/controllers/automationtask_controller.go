package controllers

import (
	"context"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	nightglowv1 "github.com/orderout/nightglow-operator/api/v1alpha1"
	"github.com/orderout/nightglow-operator/internal/browserless"
)

// AutomationTaskReconciler reconciles AutomationTask objects.
// It submits tasks to SmilingFriend, polls progress, logs every action
// into status.actionLog, and creates immutable TaskRecord objects on completion.
type AutomationTaskReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=automationtasks,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=automationtasks/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=browsersessions,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=browsersessions/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=browserlesspools,verbs=get;list;watch
// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=taskrecords,verbs=get;list;watch;create

func (r *AutomationTaskReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var task nightglowv1.AutomationTask
	if err := r.Get(ctx, req.NamespacedName, &task); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	logger.Info("Reconciling AutomationTask", "name", task.Name, "phase", task.Status.Phase)

	switch task.Status.Phase {
	case "", "Pending":
		return r.handlePending(ctx, &task)
	case "Running":
		return r.handleRunning(ctx, &task)
	case "Completed", "Failed", "Timeout", "Cancelled":
		// Terminal — ensure record exists
		return r.ensureRecord(ctx, &task)
	default:
		return ctrl.Result{}, nil
	}
}

func (r *AutomationTaskReconciler) handlePending(ctx context.Context, task *nightglowv1.AutomationTask) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// Resolve session
	session, err := r.resolveSession(ctx, task)
	if err != nil {
		return r.setTaskPhase(ctx, task, "Pending", fmt.Sprintf("Session resolution failed: %v", err))
	}

	if session.Status.Phase != "Active" && session.Status.Phase != "Persisted" {
		return r.setTaskPhase(ctx, task, "Pending", fmt.Sprintf("Session not ready (phase: %s)", session.Status.Phase))
	}

	// Resolve pool to get API endpoint
	apiClient, err := r.resolveAPIClient(ctx, session)
	if err != nil {
		return r.setTaskPhase(ctx, task, "Pending", fmt.Sprintf("Pool API resolution failed: %v", err))
	}

	// Build and submit the task
	submitReq := browserless.SubmitTaskRequest{
		TaskName:       task.Spec.TaskName,
		Input:          task.Spec.Input,
		SessionID:      session.Status.SessionID,
		PersistSession: task.Spec.PersistSession,
		IdleProfile:    task.Spec.IdleProfile,
		Timeout:        task.Spec.Timeout * 1000, // seconds → ms
		WebhookURL:     task.Spec.WebhookURL,
	}

	resp, err := apiClient.SubmitTask(ctx, submitReq)
	if err != nil {
		logger.Error(err, "Failed to submit task")
		return r.setTaskPhase(ctx, task, "Pending", fmt.Sprintf("Task submission failed: %v", err))
	}

	// Lock the session
	session.Status.Phase = "Locked"
	session.Status.LockedBy = task.Name
	if err := r.Status().Update(ctx, session); err != nil {
		logger.Error(err, "Failed to lock session")
	}

	// Update task status
	task.Status.Phase = "Running"
	task.Status.TaskID = resp.TaskID
	task.Status.Progress = "0/?"

	setCondition(&task.Status.Conditions, metav1.Condition{
		Type:               "Running",
		Status:             metav1.ConditionTrue,
		Reason:             "TaskSubmitted",
		Message:            fmt.Sprintf("Task submitted with ID %s", resp.TaskID),
		LastTransitionTime: metav1.Now(),
	})

	if err := r.Status().Update(ctx, task); err != nil {
		return ctrl.Result{}, err
	}

	logger.Info("Task submitted", "taskID", resp.TaskID, "taskName", task.Spec.TaskName)
	return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
}

func (r *AutomationTaskReconciler) handleRunning(ctx context.Context, task *nightglowv1.AutomationTask) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	session, err := r.resolveSession(ctx, task)
	if err != nil {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}

	apiClient, err := r.resolveAPIClient(ctx, session)
	if err != nil {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}

	// Poll task status from SmilingFriend
	status, err := apiClient.GetTaskStatus(ctx, task.Status.TaskID)
	if err != nil {
		logger.Error(err, "Failed to poll task status")
		return ctrl.Result{RequeueAfter: 3 * time.Second}, nil
	}

	// Update progress
	if status.Progress != nil {
		task.Status.Progress = fmt.Sprintf("%d/%d", status.Progress.CurrentAction, status.Progress.TotalActions)
		task.Status.CurrentAction = &nightglowv1.ActionProgress{
			Index: status.Progress.CurrentAction,
			Total: status.Progress.TotalActions,
			Name:  status.Progress.CurrentActionName,
		}

		// Log action progress to actionLog
		r.appendActionLog(task, status.Progress)
	}

	switch status.Status {
	case "completed":
		return r.handleCompleted(ctx, task, session, status)
	case "failed":
		return r.handleFailed(ctx, task, session, status)
	case "timeout":
		return r.handleTimeout(ctx, task, session, status)
	case "cancelled":
		return r.handleCancelled(ctx, task, session)
	default:
		// Still running — update status and requeue
		if err := r.Status().Update(ctx, task); err != nil {
			if errors.IsConflict(err) {
				return ctrl.Result{Requeue: true}, nil
			}
		}
		return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
	}
}

func (r *AutomationTaskReconciler) handleCompleted(ctx context.Context, task *nightglowv1.AutomationTask, session *nightglowv1.BrowserSession, status *browserless.TaskStatus) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	task.Status.Phase = "Completed"

	if status.Result != nil {
		task.Status.Output = status.Result.Output

		if status.Result.Metrics != nil {
			task.Status.Metrics = &nightglowv1.TaskMetricsStatus{
				StartedAt:       status.Result.Metrics.StartedAt,
				CompletedAt:     status.Result.Metrics.CompletedAt,
				TotalDurationMs: status.Result.Metrics.TotalDurationMs,
				ActionCount:     status.Result.Metrics.ActionCount,
				IdleTimeMs:      status.Result.Metrics.IdleTimeMs,
				RetryCount:      status.Result.Metrics.RetryCount,
			}
		}
	}

	setCondition(&task.Status.Conditions, metav1.Condition{
		Type:               "Complete",
		Status:             metav1.ConditionTrue,
		Reason:             "TaskCompleted",
		Message:            "Task completed successfully",
		LastTransitionTime: metav1.Now(),
	})

	if err := r.Status().Update(ctx, task); err != nil {
		return ctrl.Result{}, err
	}

	// Unlock session
	r.unlockSession(ctx, session)

	// Create persistent TaskRecord
	if err := r.createTaskRecord(ctx, task, status); err != nil {
		logger.Error(err, "Failed to create TaskRecord")
	}

	logger.Info("Task completed", "taskName", task.Spec.TaskName, "duration", task.Status.Metrics)
	return ctrl.Result{}, nil
}

func (r *AutomationTaskReconciler) handleFailed(ctx context.Context, task *nightglowv1.AutomationTask, session *nightglowv1.BrowserSession, status *browserless.TaskStatus) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	task.Status.Phase = "Failed"

	if status.Result != nil && status.Result.Error != nil {
		task.Status.Error = &nightglowv1.TaskErrorStatus{
			Code:        status.Result.Error.Code,
			Message:     status.Result.Error.Message,
			ActionIndex: status.Result.Error.ActionIndex,
			ActionName:  status.Result.Error.ActionName,
			Recoverable: status.Result.Error.Recoverable,
		}

		if status.Result.Metrics != nil {
			task.Status.Metrics = &nightglowv1.TaskMetricsStatus{
				StartedAt:       status.Result.Metrics.StartedAt,
				CompletedAt:     status.Result.Metrics.CompletedAt,
				TotalDurationMs: status.Result.Metrics.TotalDurationMs,
				ActionCount:     status.Result.Metrics.ActionCount,
				IdleTimeMs:      status.Result.Metrics.IdleTimeMs,
				RetryCount:      status.Result.Metrics.RetryCount,
			}
		}
	}

	setCondition(&task.Status.Conditions, metav1.Condition{
		Type:               "Complete",
		Status:             metav1.ConditionFalse,
		Reason:             "TaskFailed",
		Message:            task.Status.Error.Message,
		LastTransitionTime: metav1.Now(),
	})

	if err := r.Status().Update(ctx, task); err != nil {
		return ctrl.Result{}, err
	}

	r.unlockSession(ctx, session)

	// Still create a record for failed tasks
	if err := r.createTaskRecord(ctx, task, status); err != nil {
		logger.Error(err, "Failed to create TaskRecord for failed task")
	}

	logger.Info("Task failed", "taskName", task.Spec.TaskName, "error", task.Status.Error)
	return ctrl.Result{}, nil
}

func (r *AutomationTaskReconciler) handleTimeout(ctx context.Context, task *nightglowv1.AutomationTask, session *nightglowv1.BrowserSession, status *browserless.TaskStatus) (ctrl.Result, error) {
	task.Status.Phase = "Timeout"
	task.Status.Error = &nightglowv1.TaskErrorStatus{
		Code:    "TIMEOUT",
		Message: fmt.Sprintf("Task timed out after %ds", task.Spec.Timeout),
	}

	setCondition(&task.Status.Conditions, metav1.Condition{
		Type:               "Complete",
		Status:             metav1.ConditionFalse,
		Reason:             "TaskTimeout",
		Message:            task.Status.Error.Message,
		LastTransitionTime: metav1.Now(),
	})

	if err := r.Status().Update(ctx, task); err != nil {
		return ctrl.Result{}, err
	}

	r.unlockSession(ctx, session)

	if err := r.createTaskRecord(ctx, task, status); err != nil {
		log.FromContext(ctx).Error(err, "Failed to create TaskRecord for timed-out task")
	}

	return ctrl.Result{}, nil
}

func (r *AutomationTaskReconciler) handleCancelled(ctx context.Context, task *nightglowv1.AutomationTask, session *nightglowv1.BrowserSession) (ctrl.Result, error) {
	task.Status.Phase = "Cancelled"

	setCondition(&task.Status.Conditions, metav1.Condition{
		Type:               "Complete",
		Status:             metav1.ConditionFalse,
		Reason:             "TaskCancelled",
		Message:            "Task was cancelled",
		LastTransitionTime: metav1.Now(),
	})

	if err := r.Status().Update(ctx, task); err != nil {
		return ctrl.Result{}, err
	}

	r.unlockSession(ctx, session)
	return ctrl.Result{}, nil
}

// createTaskRecord builds and creates an immutable TaskRecord from a completed task.
func (r *AutomationTaskReconciler) createTaskRecord(ctx context.Context, task *nightglowv1.AutomationTask, status *browserless.TaskStatus) error {
	recordName := task.Spec.RecordRef
	if recordName == "" {
		recordName = fmt.Sprintf("%s-%d", task.Name, time.Now().Unix())
	}

	// Check if already exists
	var existing nightglowv1.TaskRecord
	if err := r.Get(ctx, types.NamespacedName{Name: recordName, Namespace: task.Namespace}, &existing); err == nil {
		// Record already exists
		task.Status.RecordRef = recordName
		return r.Status().Update(ctx, task)
	}

	// Build action records from the task's action log
	var actionRecords []nightglowv1.ActionRecord
	for i, spec := range task.Spec.Actions {
		ar := nightglowv1.ActionRecord{
			Name:   spec.Name,
			Type:   spec.Type,
			Target: spec.Target,
			Params: spec.Params,
		}
		// Match with action log result if available
		if i < len(task.Status.ActionLog) {
			ar.Result = task.Status.ActionLog[i]
		} else {
			ar.Result = nightglowv1.ActionResult{
				Index:     i,
				Type:      spec.Type,
				Name:      spec.Name,
				Success:   task.Status.Phase == "Completed",
				Timestamp: time.Now().UnixMilli(),
			}
		}
		actionRecords = append(actionRecords, ar)
	}

	// Build result record
	resultStatus := task.Status.Phase
	if resultStatus == "Completed" {
		resultStatus = "completed"
	} else if resultStatus == "Failed" {
		resultStatus = "failed"
	} else if resultStatus == "Timeout" {
		resultStatus = "timeout"
	} else {
		resultStatus = "cancelled"
	}

	resultRecord := nightglowv1.TaskResultRecord{
		Status: resultStatus,
		Output: task.Status.Output,
		Error:  task.Status.Error,
	}
	if task.Status.Metrics != nil {
		resultRecord.Metrics = *task.Status.Metrics
	}

	var startedAt, completedAt int64
	if task.Status.Metrics != nil {
		startedAt = task.Status.Metrics.StartedAt
		completedAt = task.Status.Metrics.CompletedAt
	} else {
		startedAt = task.CreationTimestamp.UnixMilli()
		completedAt = time.Now().UnixMilli()
	}

	record := &nightglowv1.TaskRecord{
		ObjectMeta: metav1.ObjectMeta{
			Name:      recordName,
			Namespace: task.Namespace,
			Labels: map[string]string{
				"nightglow.orderout.io/task-name": task.Spec.TaskName,
				"nightglow.orderout.io/session":   task.Spec.SessionRef,
				"nightglow.orderout.io/task":      task.Name,
				"nightglow.orderout.io/status":    resultStatus,
			},
			OwnerReferences: []metav1.OwnerReference{
				{
					APIVersion: task.APIVersion,
					Kind:       task.Kind,
					Name:       task.Name,
					UID:        task.UID,
				},
			},
		},
		Spec: nightglowv1.TaskRecordSpec{
			TaskName:    task.Spec.TaskName,
			SessionRef:  task.Spec.SessionRef,
			TaskRef:     task.Name,
			Input:       task.Spec.Input,
			Actions:     actionRecords,
			Result:      resultRecord,
			StartedAt:   startedAt,
			CompletedAt: completedAt,
		},
	}

	if err := r.Create(ctx, record); err != nil {
		return fmt.Errorf("creating TaskRecord: %w", err)
	}

	task.Status.RecordRef = recordName
	return r.Status().Update(ctx, task)
}

// appendActionLog adds a progress entry to the action log if it's a new action.
func (r *AutomationTaskReconciler) appendActionLog(task *nightglowv1.AutomationTask, progress *browserless.Progress) {
	idx := progress.CurrentAction
	// Only log if this is a new action index we haven't seen
	for _, entry := range task.Status.ActionLog {
		if entry.Index == idx {
			return
		}
	}

	actionType := ""
	if idx < len(task.Spec.Actions) {
		actionType = task.Spec.Actions[idx].Type
	}

	task.Status.ActionLog = append(task.Status.ActionLog, nightglowv1.ActionResult{
		Index:     idx,
		Name:      progress.CurrentActionName,
		Type:      actionType,
		Success:   true, // Will be updated on completion/failure
		Timestamp: time.Now().UnixMilli(),
	})
}

func (r *AutomationTaskReconciler) ensureRecord(ctx context.Context, task *nightglowv1.AutomationTask) (ctrl.Result, error) {
	if task.Status.RecordRef != "" {
		return ctrl.Result{}, nil
	}
	// Create record if missing
	if err := r.createTaskRecord(ctx, task, nil); err != nil {
		return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
	}
	return ctrl.Result{}, nil
}

func (r *AutomationTaskReconciler) resolveSession(ctx context.Context, task *nightglowv1.AutomationTask) (*nightglowv1.BrowserSession, error) {
	var session nightglowv1.BrowserSession
	err := r.Get(ctx, types.NamespacedName{
		Name:      task.Spec.SessionRef,
		Namespace: task.Namespace,
	}, &session)
	return &session, err
}

func (r *AutomationTaskReconciler) resolveAPIClient(ctx context.Context, session *nightglowv1.BrowserSession) (*browserless.Client, error) {
	var pool nightglowv1.BrowserlessPool
	if err := r.Get(ctx, types.NamespacedName{
		Name:      session.Spec.PoolRef,
		Namespace: session.Namespace,
	}, &pool); err != nil {
		return nil, err
	}
	if pool.Status.HTTPEndpoint == "" {
		return nil, fmt.Errorf("pool %s has no HTTP endpoint", pool.Name)
	}
	return browserless.NewClient(pool.Status.HTTPEndpoint), nil
}

func (r *AutomationTaskReconciler) unlockSession(ctx context.Context, session *nightglowv1.BrowserSession) {
	session.Status.Phase = "Active"
	session.Status.LockedBy = ""
	if err := r.Status().Update(ctx, session); err != nil {
		log.FromContext(ctx).Error(err, "Failed to unlock session")
	}
}

func (r *AutomationTaskReconciler) setTaskPhase(ctx context.Context, task *nightglowv1.AutomationTask, phase string, message string) (ctrl.Result, error) {
	task.Status.Phase = phase
	setCondition(&task.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             phase,
		Message:            message,
		LastTransitionTime: metav1.Now(),
	})
	if err := r.Status().Update(ctx, task); err != nil {
		if errors.IsConflict(err) {
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
}

func (r *AutomationTaskReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&nightglowv1.AutomationTask{}).
		Complete(r)
}
