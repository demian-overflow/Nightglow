package controllers

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	nightglowv1 "github.com/orderout/nightglow-operator/api/v1alpha1"
)

// BrowserlessPoolReconciler reconciles BrowserlessPool objects.
// It creates/updates a Deployment + Service for each pool.
type BrowserlessPoolReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=browserlesspools,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=nightglow.orderout.io,resources=browserlesspools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete

func (r *BrowserlessPoolReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// Fetch the BrowserlessPool
	var pool nightglowv1.BrowserlessPool
	if err := r.Get(ctx, req.NamespacedName, &pool); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	logger.Info("Reconciling BrowserlessPool", "name", pool.Name)

	// Reconcile Deployment
	deploy, err := r.reconcileDeployment(ctx, &pool)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconciling deployment: %w", err)
	}

	// Reconcile Service
	if err := r.reconcileService(ctx, &pool); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconciling service: %w", err)
	}

	// Update status
	pool.Status.ReadyReplicas = deploy.Status.ReadyReplicas
	pool.Status.Endpoint = fmt.Sprintf("ws://%s.%s.svc:%d", pool.Name, pool.Namespace, pool.Spec.Port)
	pool.Status.HTTPEndpoint = fmt.Sprintf("http://%s.%s.svc:%d", pool.Name, pool.Namespace, pool.Spec.Port)

	if deploy.Status.ReadyReplicas > 0 {
		pool.Status.Phase = "Running"
	} else if deploy.Status.Replicas > 0 {
		pool.Status.Phase = "Pending"
	} else {
		pool.Status.Phase = "Pending"
	}

	if deploy.Status.ReadyReplicas > 0 && deploy.Status.ReadyReplicas < *deploy.Spec.Replicas {
		pool.Status.Phase = "Degraded"
	}

	if err := r.Status().Update(ctx, &pool); err != nil {
		if errors.IsConflict(err) {
			return ctrl.Result{Requeue: true}, nil
		}
		return ctrl.Result{}, fmt.Errorf("updating status: %w", err)
	}

	return ctrl.Result{}, nil
}

func (r *BrowserlessPoolReconciler) reconcileDeployment(ctx context.Context, pool *nightglowv1.BrowserlessPool) (*appsv1.Deployment, error) {
	image := pool.Spec.Image
	if image == "" {
		image = "ghcr.io/browserless/multi:latest"
	}
	replicas := pool.Spec.Replicas
	if replicas == 0 {
		replicas = 1
	}
	port := pool.Spec.Port
	if port == 0 {
		port = 3000
	}
	concurrent := pool.Spec.Concurrent
	if concurrent == 0 {
		concurrent = 10
	}

	token := pool.Spec.Token
	env := []corev1.EnvVar{
		{Name: "CONCURRENT", Value: fmt.Sprintf("%d", concurrent)},
	}
	if pool.Spec.TokenSecretRef != nil {
		env = append(env, corev1.EnvVar{
			Name: "TOKEN",
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: pool.Spec.TokenSecretRef.Name},
					Key:                  pool.Spec.TokenSecretRef.Key,
				},
			},
		})
	} else if token != "" {
		env = append(env, corev1.EnvVar{Name: "TOKEN", Value: token})
	}

	labels := map[string]string{
		"app.kubernetes.io/name":       "browserless",
		"app.kubernetes.io/instance":   pool.Name,
		"app.kubernetes.io/managed-by": "nightglow-operator",
	}

	container := corev1.Container{
		Name:  "browserless",
		Image: image,
		Ports: []corev1.ContainerPort{
			{Name: "http", ContainerPort: port, Protocol: corev1.ProtocolTCP},
		},
		Env: env,
		ReadinessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{
				HTTPGet: &corev1.HTTPGetAction{
					Path: "/pressure",
					Port: intstr.FromInt32(port),
				},
			},
			InitialDelaySeconds: 5,
			PeriodSeconds:       10,
		},
		LivenessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{
				HTTPGet: &corev1.HTTPGetAction{
					Path: "/pressure",
					Port: intstr.FromInt32(port),
				},
			},
			InitialDelaySeconds: 15,
			PeriodSeconds:       20,
		},
	}

	// Apply resource limits if specified
	if pool.Spec.Resources != nil {
		container.Resources = buildResourceRequirements(pool.Spec.Resources)
	}

	deploy := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      pool.Name,
			Namespace: pool.Namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, deploy, func() error {
		deploy.Labels = labels
		deploy.Spec = appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{container},
				},
			},
		}
		return controllerutil.SetControllerReference(pool, deploy, r.Scheme)
	})

	if err != nil {
		return nil, err
	}

	// Re-fetch to get status
	if err := r.Get(ctx, types.NamespacedName{Name: deploy.Name, Namespace: deploy.Namespace}, deploy); err != nil {
		return nil, err
	}
	return deploy, nil
}

func (r *BrowserlessPoolReconciler) reconcileService(ctx context.Context, pool *nightglowv1.BrowserlessPool) error {
	port := pool.Spec.Port
	if port == 0 {
		port = 3000
	}

	labels := map[string]string{
		"app.kubernetes.io/name":     "browserless",
		"app.kubernetes.io/instance": pool.Name,
	}

	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      pool.Name,
			Namespace: pool.Namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
		svc.Labels = labels
		svc.Spec = corev1.ServiceSpec{
			Selector: labels,
			Ports: []corev1.ServicePort{
				{
					Name:       "http",
					Port:       port,
					TargetPort: intstr.FromInt32(port),
					Protocol:   corev1.ProtocolTCP,
				},
			},
			Type: corev1.ServiceTypeClusterIP,
		}
		return controllerutil.SetControllerReference(pool, svc, r.Scheme)
	})

	return err
}

func buildResourceRequirements(r *nightglowv1.ResourceRequirements) corev1.ResourceRequirements {
	req := corev1.ResourceRequirements{}
	if r.CPURequest != "" || r.MemoryRequest != "" {
		req.Requests = corev1.ResourceList{}
		if r.CPURequest != "" {
			req.Requests[corev1.ResourceCPU] = resource.MustParse(r.CPURequest)
		}
		if r.MemoryRequest != "" {
			req.Requests[corev1.ResourceMemory] = resource.MustParse(r.MemoryRequest)
		}
	}
	if r.CPULimit != "" || r.MemoryLimit != "" {
		req.Limits = corev1.ResourceList{}
		if r.CPULimit != "" {
			req.Limits[corev1.ResourceCPU] = resource.MustParse(r.CPULimit)
		}
		if r.MemoryLimit != "" {
			req.Limits[corev1.ResourceMemory] = resource.MustParse(r.MemoryLimit)
		}
	}
	return req
}

func (r *BrowserlessPoolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&nightglowv1.BrowserlessPool{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Complete(r)
}
