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

// BrowserSessionReconciler reconciles BrowserSession objects.
// It creates sessions on the SmilingFriend server via the pool's endpoint,
// tracks their lifecycle, and handles TTL-based expiration.
type BrowserSessionReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=browsersessions,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=browsersessions/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=browserlesspools,verbs=get;list;watch

func (r *BrowserSessionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var session nightglowv1.BrowserSession
	if err := r.Get(ctx, req.NamespacedName, &session); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Handle deletion
	if !session.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, &session)
	}

	logger.Info("Reconciling BrowserSession", "name", session.Name, "phase", session.Status.Phase)

	// Resolve pool
	pool, err := r.resolvePool(ctx, &session)
	if err != nil {
		return r.setPhase(ctx, &session, "Failed", fmt.Sprintf("Pool resolution failed: %v", err))
	}

	if pool.Status.Phase != "Running" {
		return r.setPhase(ctx, &session, "Pending", "Waiting for pool to be Running")
	}

	apiClient := browserless.NewClient(pool.Status.HTTPEndpoint)

	switch session.Status.Phase {
	case "", "Pending":
		return r.handlePending(ctx, &session, apiClient)
	case "Active":
		return r.handleActive(ctx, &session, apiClient)
	case "Locked":
		// Locked by a running task — requeue to check later
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	case "Persisted":
		// Idle persisted state — check TTL
		return r.checkTTL(ctx, &session)
	default:
		return ctrl.Result{}, nil
	}
}

func (r *BrowserSessionReconciler) handlePending(ctx context.Context, session *nightglowv1.BrowserSession, apiClient *browserless.Client) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// Build session creation request
	createReq := browserless.CreateSessionRequest{
		SessionID: session.Name,
	}
	if session.Spec.Viewport != nil {
		createReq.Viewport = &browserless.Viewport{
			Width:  session.Spec.Viewport.Width,
			Height: session.Spec.Viewport.Height,
		}
	}
	if session.Spec.LaunchParams != nil {
		createReq.LaunchParams = session.Spec.LaunchParams
	}
	if session.Spec.TTL > 0 {
		createReq.TTL = session.Spec.TTL * 1000 // Convert seconds to ms
	}

	resp, err := apiClient.CreateSession(ctx, createReq)
	if err != nil {
		logger.Error(err, "Failed to create browser session")
		return r.setPhase(ctx, session, "Pending", fmt.Sprintf("Session creation failed: %v", err))
	}

	session.Status.Phase = "Active"
	session.Status.SessionID = resp.SessionID
	session.Status.LastActivityAt = time.Now().UnixMilli()

	setCondition(&session.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionTrue,
		Reason:             "SessionCreated",
		Message:            "Browser session is active",
		LastTransitionTime: metav1.Now(),
	})

	if err := r.Status().Update(ctx, session); err != nil {
		return ctrl.Result{}, err
	}

	logger.Info("Browser session created", "sessionID", resp.SessionID)
	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *BrowserSessionReconciler) handleActive(ctx context.Context, session *nightglowv1.BrowserSession, apiClient *browserless.Client) (ctrl.Result, error) {
	// Check if session still exists on the server
	info, err := apiClient.GetSession(ctx, session.Status.SessionID)
	if err != nil {
		// Session may have expired on the server
		if session.Spec.Persistent {
			session.Status.Phase = "Persisted"
		} else {
			session.Status.Phase = "Expired"
		}
		if updateErr := r.Status().Update(ctx, session); updateErr != nil {
			return ctrl.Result{}, updateErr
		}
		return ctrl.Result{}, nil
	}

	// Update status from server
	session.Status.CurrentURL = info.CurrentURL
	session.Status.LastActivityAt = info.LastActivityAt

	if info.Locked {
		session.Status.Phase = "Locked"
		session.Status.LockedBy = info.LockedBy
	} else {
		session.Status.Phase = "Active"
		session.Status.LockedBy = ""
	}

	if err := r.Status().Update(ctx, session); err != nil {
		if errors.IsConflict(err) {
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, err
	}

	return r.checkTTL(ctx, session)
}

func (r *BrowserSessionReconciler) checkTTL(ctx context.Context, session *nightglowv1.BrowserSession) (ctrl.Result, error) {
	if session.Spec.TTL <= 0 {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}

	age := time.Since(session.CreationTimestamp.Time)
	ttl := time.Duration(session.Spec.TTL) * time.Second

	if age > ttl && session.Status.Phase != "Locked" {
		session.Status.Phase = "Expired"
		setCondition(&session.Status.Conditions, metav1.Condition{
			Type:               "Ready",
			Status:             metav1.ConditionFalse,
			Reason:             "TTLExpired",
			Message:            fmt.Sprintf("Session TTL of %s exceeded", ttl),
			LastTransitionTime: metav1.Now(),
		})
		if err := r.Status().Update(ctx, session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	remaining := ttl - age
	return ctrl.Result{RequeueAfter: remaining}, nil
}

func (r *BrowserSessionReconciler) handleDeletion(ctx context.Context, session *nightglowv1.BrowserSession) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// Resolve pool to get API client
	pool, err := r.resolvePool(ctx, session)
	if err == nil && pool.Status.HTTPEndpoint != "" {
		apiClient := browserless.NewClient(pool.Status.HTTPEndpoint)
		deleteStorage := !session.Spec.Persistent
		if delErr := apiClient.DeleteSession(ctx, session.Status.SessionID, deleteStorage); delErr != nil {
			logger.Error(delErr, "Failed to delete session from server (may already be gone)")
		}
	}

	logger.Info("BrowserSession deleted", "name", session.Name)
	return ctrl.Result{}, nil
}

func (r *BrowserSessionReconciler) resolvePool(ctx context.Context, session *nightglowv1.BrowserSession) (*nightglowv1.BrowserlessPool, error) {
	var pool nightglowv1.BrowserlessPool
	err := r.Get(ctx, types.NamespacedName{
		Name:      session.Spec.PoolRef,
		Namespace: session.Namespace,
	}, &pool)
	return &pool, err
}

func (r *BrowserSessionReconciler) setPhase(ctx context.Context, session *nightglowv1.BrowserSession, phase string, message string) (ctrl.Result, error) {
	session.Status.Phase = phase
	setCondition(&session.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             phase,
		Message:            message,
		LastTransitionTime: metav1.Now(),
	})
	if err := r.Status().Update(ctx, session); err != nil {
		if errors.IsConflict(err) {
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
}

func (r *BrowserSessionReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&nightglowv1.BrowserSession{}).
		Complete(r)
}

// setCondition updates or appends a condition in a conditions slice.
func setCondition(conditions *[]metav1.Condition, condition metav1.Condition) {
	for i, c := range *conditions {
		if c.Type == condition.Type {
			(*conditions)[i] = condition
			return
		}
	}
	*conditions = append(*conditions, condition)
}
