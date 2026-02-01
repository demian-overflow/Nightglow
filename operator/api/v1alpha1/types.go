// Package v1alpha1 contains API types for the Nightglow browser automation operator.
//
// CRD hierarchy:
//
//	BrowserlessPool  — manages a pool of browserless instances (starting point)
//	BrowserSession   — a browser session connected to a pool
//	AutomationTask   — a task submitted against a session
//	TaskRecord       — persistent, immutable record of a completed task + all actions
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ============================================================================
// BrowserlessPool — manages the browserless browser fleet
// ============================================================================

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="integer",JSONPath=".status.readyReplicas"
// +kubebuilder:printcolumn:name="Capacity",type="integer",JSONPath=".spec.concurrent"
// +kubebuilder:printcolumn:name="Sessions",type="integer",JSONPath=".status.activeSessions"
// +kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.phase"
type BrowserlessPool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   BrowserlessPoolSpec   `json:"spec,omitempty"`
	Status BrowserlessPoolStatus `json:"status,omitempty"`
}

type BrowserlessPoolSpec struct {
	// Image is the browserless container image.
	// +kubebuilder:default="ghcr.io/browserless/multi:latest"
	Image string `json:"image,omitempty"`

	// Replicas is the number of browserless pods.
	// +kubebuilder:default=1
	// +kubebuilder:validation:Minimum=1
	Replicas int32 `json:"replicas,omitempty"`

	// Concurrent is the max concurrent browser sessions per replica.
	// +kubebuilder:default=10
	Concurrent int32 `json:"concurrent,omitempty"`

	// Token for browserless API authentication.
	Token string `json:"token,omitempty"`

	// TokenSecretRef references a Secret containing the token.
	TokenSecretRef *SecretKeyRef `json:"tokenSecretRef,omitempty"`

	// Port the browserless service listens on.
	// +kubebuilder:default=3000
	Port int32 `json:"port,omitempty"`

	// Stealth enables the stealth endpoint.
	// +kubebuilder:default=false
	Stealth bool `json:"stealth,omitempty"`

	// Resources for each browserless pod.
	Resources *ResourceRequirements `json:"resources,omitempty"`

	// HealthCheck configuration.
	HealthCheck *HealthCheckConfig `json:"healthCheck,omitempty"`
}

type BrowserlessPoolStatus struct {
	// Phase of the pool: Pending, Running, Degraded, Failed.
	Phase string `json:"phase,omitempty"`

	// ReadyReplicas is the count of healthy browserless pods.
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`

	// ActiveSessions across all replicas.
	ActiveSessions int32 `json:"activeSessions,omitempty"`

	// Endpoint is the internal service URL for websocket connections.
	Endpoint string `json:"endpoint,omitempty"`

	// HTTPEndpoint is the HTTP URL for health/pressure checks.
	HTTPEndpoint string `json:"httpEndpoint,omitempty"`

	// Conditions for standard k8s condition tracking.
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type BrowserlessPoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []BrowserlessPool `json:"items"`
}

// ============================================================================
// BrowserSession — a live browser session bound to a pool
// ============================================================================

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Pool",type="string",JSONPath=".spec.poolRef"
// +kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="URL",type="string",JSONPath=".status.currentURL",priority=1
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
type BrowserSession struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   BrowserSessionSpec   `json:"spec,omitempty"`
	Status BrowserSessionStatus `json:"status,omitempty"`
}

type BrowserSessionSpec struct {
	// PoolRef is the name of the BrowserlessPool to connect to.
	// +kubebuilder:validation:Required
	PoolRef string `json:"poolRef"`

	// Viewport size for the browser page.
	Viewport *Viewport `json:"viewport,omitempty"`

	// LaunchParams for the browserless connection.
	LaunchParams *LaunchParams `json:"launchParams,omitempty"`

	// TTL is the session time-to-live in seconds. 0 = no auto-expire.
	// +kubebuilder:default=300
	TTL int64 `json:"ttl,omitempty"`

	// Persistent means session state (cookies, localStorage) is saved
	// to a PVC on close and restored on recreation.
	// +kubebuilder:default=false
	Persistent bool `json:"persistent,omitempty"`

	// IdleProfile preset for tasks using this session.
	// +kubebuilder:validation:Enum=casual;focused;rushed;methodical
	// +kubebuilder:default="casual"
	IdleProfile string `json:"idleProfile,omitempty"`

	// RestoreFrom is an optional session name to restore state from.
	RestoreFrom string `json:"restoreFrom,omitempty"`
}

type BrowserSessionStatus struct {
	// Phase: Pending, Active, Locked, Persisted, Expired, Failed.
	Phase string `json:"phase,omitempty"`

	// SessionID is the internal session identifier.
	SessionID string `json:"sessionID,omitempty"`

	// CurrentURL the browser is on.
	CurrentURL string `json:"currentURL,omitempty"`

	// LockedBy is the AutomationTask name currently holding the lock.
	LockedBy string `json:"lockedBy,omitempty"`

	// State captured from the browser.
	State *SessionStateSnapshot `json:"state,omitempty"`

	// LastActivityAt is the unix timestamp of last action.
	LastActivityAt int64 `json:"lastActivityAt,omitempty"`

	// Conditions for standard k8s condition tracking.
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type BrowserSessionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []BrowserSession `json:"items"`
}

// ============================================================================
// AutomationTask — a task to execute against a session
// ============================================================================

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Task",type="string",JSONPath=".spec.taskName"
// +kubebuilder:printcolumn:name="Session",type="string",JSONPath=".spec.sessionRef"
// +kubebuilder:printcolumn:name="Phase",type="string",JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Actions",type="string",JSONPath=".status.progress"
// +kubebuilder:printcolumn:name="Duration",type="string",JSONPath=".status.metrics.totalDurationMs"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
type AutomationTask struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AutomationTaskSpec   `json:"spec,omitempty"`
	Status AutomationTaskStatus `json:"status,omitempty"`
}

type AutomationTaskSpec struct {
	// TaskName is the registered task definition name (e.g. "login", "extractData").
	// +kubebuilder:validation:Required
	TaskName string `json:"taskName"`

	// SessionRef is the name of the BrowserSession to execute against.
	// +kubebuilder:validation:Required
	SessionRef string `json:"sessionRef"`

	// Input is the task-specific input data (JSON).
	// +kubebuilder:validation:Type=object
	// +kubebuilder:pruning:PreserveUnknownFields
	Input map[string]interface{} `json:"input,omitempty"`

	// Actions defines the action sequence. If empty, the task definition
	// from the SmilingFriend server is used.
	Actions []ActionSpec `json:"actions,omitempty"`

	// IdleProfile overrides the session-level idle profile for this task.
	// +kubebuilder:validation:Enum=casual;focused;rushed;methodical;custom
	IdleProfile string `json:"idleProfile,omitempty"`

	// CustomIdleProfile for fine-grained control when idleProfile is "custom".
	CustomIdleProfile *IdleProfileSpec `json:"customIdleProfile,omitempty"`

	// Timeout in seconds for the entire task.
	// +kubebuilder:default=120
	Timeout int64 `json:"timeout,omitempty"`

	// RetryPolicy for failed actions.
	RetryPolicy *RetryPolicySpec `json:"retryPolicy,omitempty"`

	// PersistSession after task completion.
	// +kubebuilder:default=true
	PersistSession bool `json:"persistSession,omitempty"`

	// WebhookURL to call on completion.
	WebhookURL string `json:"webhookUrl,omitempty"`

	// RecordRef is the name for the TaskRecord to create on completion.
	// If empty, auto-generated as {task-name}-{timestamp}.
	RecordRef string `json:"recordRef,omitempty"`
}

type AutomationTaskStatus struct {
	// Phase: Pending, Running, Completed, Failed, Timeout, Cancelled.
	Phase string `json:"phase,omitempty"`

	// TaskID is the internal task identifier from SmilingFriend.
	TaskID string `json:"taskID,omitempty"`

	// Progress shows current action execution state.
	Progress string `json:"progress,omitempty"`

	// CurrentAction being executed.
	CurrentAction *ActionProgress `json:"currentAction,omitempty"`

	// Metrics from the completed task.
	Metrics *TaskMetricsStatus `json:"metrics,omitempty"`

	// Output from the task (JSON).
	// +kubebuilder:pruning:PreserveUnknownFields
	Output map[string]interface{} `json:"output,omitempty"`

	// Error details if failed.
	Error *TaskErrorStatus `json:"error,omitempty"`

	// RecordRef is the name of the TaskRecord created for this execution.
	RecordRef string `json:"recordRef,omitempty"`

	// ActionLog is a running log of each action result during execution.
	ActionLog []ActionResult `json:"actionLog,omitempty"`

	// Conditions for standard k8s condition tracking.
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type AutomationTaskList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AutomationTask `json:"items"`
}

// ============================================================================
// TaskRecord — persistent, immutable record of a completed task execution
// ============================================================================

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Task",type="string",JSONPath=".spec.taskName"
// +kubebuilder:printcolumn:name="Session",type="string",JSONPath=".spec.sessionRef"
// +kubebuilder:printcolumn:name="Status",type="string",JSONPath=".spec.result.status"
// +kubebuilder:printcolumn:name="Actions",type="integer",JSONPath=".spec.result.metrics.actionCount"
// +kubebuilder:printcolumn:name="Duration",type="string",JSONPath=".spec.result.metrics.totalDurationMs"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
type TaskRecord struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec TaskRecordSpec `json:"spec,omitempty"`
}

type TaskRecordSpec struct {
	// TaskName that was executed.
	TaskName string `json:"taskName"`

	// SessionRef is the session used.
	SessionRef string `json:"sessionRef"`

	// TaskRef is the AutomationTask that created this record.
	TaskRef string `json:"taskRef,omitempty"`

	// Input that was provided.
	// +kubebuilder:pruning:PreserveUnknownFields
	Input map[string]interface{} `json:"input,omitempty"`

	// Actions that were defined for this execution.
	Actions []ActionRecord `json:"actions,omitempty"`

	// Result is the full outcome.
	Result TaskResultRecord `json:"result"`

	// StartedAt timestamp (unix ms).
	StartedAt int64 `json:"startedAt"`

	// CompletedAt timestamp (unix ms).
	CompletedAt int64 `json:"completedAt"`
}

// +kubebuilder:object:root=true
type TaskRecordList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []TaskRecord `json:"items"`
}

// ============================================================================
// Shared Sub-Types
// ============================================================================

// ActionSpec defines a single automation action within a task.
type ActionSpec struct {
	// Name is a human-readable label for this action.
	Name string `json:"name,omitempty"`

	// Type of action.
	// +kubebuilder:validation:Enum=navigate;click;clickAndWaitForNavigation;type;select;scroll;hover;press;wait;waitForContext;extract;screenshot;evaluate
	Type string `json:"type"`

	// Target element specification.
	Target *ActionTarget `json:"target,omitempty"`

	// Params for the action.
	Params *ActionParams `json:"params,omitempty"`

	// Assertion to run after the action.
	Assertion *ActionAssertion `json:"assertion,omitempty"`

	// OnFailure strategy.
	// +kubebuilder:validation:Enum=abort;skip;retry;fallback
	// +kubebuilder:default="abort"
	OnFailure string `json:"onFailure,omitempty"`

	// IdleOverride for this specific action's idle timing.
	IdleOverride *IdleOverride `json:"idleOverride,omitempty"`
}

type ActionTarget struct {
	Selector    string      `json:"selector,omitempty"`
	XPath       string      `json:"xpath,omitempty"`
	Text        string      `json:"text,omitempty"`
	Role        string      `json:"role,omitempty"`
	TestID      string      `json:"testId,omitempty"`
	Coordinates *Coordinate `json:"coordinates,omitempty"`
}

type Coordinate struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type ActionParams struct {
	// Navigate
	URL       string `json:"url,omitempty"`
	WaitUntil string `json:"waitUntil,omitempty"`

	// Type
	Text       string `json:"text,omitempty"`
	ClearFirst bool   `json:"clearFirst,omitempty"`
	WithErrors bool   `json:"withErrors,omitempty"`

	// Select
	Value  string   `json:"value,omitempty"`
	Values []string `json:"values,omitempty"`

	// Scroll
	Direction string `json:"direction,omitempty"`
	Pixels    int    `json:"pixels,omitempty"`
	ToElement bool   `json:"toElement,omitempty"`

	// Press
	Key string `json:"key,omitempty"`

	// Wait
	Timeout int64  `json:"timeout,omitempty"`
	State   string `json:"state,omitempty"`

	// WaitForContext
	ContextKey       string `json:"contextKey,omitempty"`
	WebhookURL       string `json:"webhookUrl,omitempty"`
	IncludeSessionID bool   `json:"includeSessionId,omitempty"`

	// Extract
	Attribute string `json:"attribute,omitempty"`
	Property  string `json:"property,omitempty"`
	InnerText bool   `json:"innerText,omitempty"`
	InnerHTML bool   `json:"innerHTML,omitempty"`

	// Evaluate
	Script string   `json:"script,omitempty"`
	Args   []string `json:"args,omitempty"`

	// Screenshot
	FullPage bool   `json:"fullPage,omitempty"`
	Encoding string `json:"encoding,omitempty"`
}

type ActionAssertion struct {
	// +kubebuilder:validation:Enum=exists;visible;text;attribute;url;custom
	Type     string `json:"type"`
	Expected string `json:"expected,omitempty"`
	Selector string `json:"selector,omitempty"`
	Timeout  int64  `json:"timeout,omitempty"`
}

type IdleProfileSpec struct {
	BaseIdle        *Range  `json:"baseIdle,omitempty"`
	AfterNavigation *Range  `json:"afterNavigation,omitempty"`
	AfterClick      *Range  `json:"afterClick,omitempty"`
	AfterType       *Range  `json:"afterType,omitempty"`
	AfterScroll     *Range  `json:"afterScroll,omitempty"`
	BeforeSubmit    *Range  `json:"beforeSubmit,omitempty"`
	DecisionTime    *Range  `json:"decisionTime,omitempty"`
	ReadingWPM      int     `json:"readingWpm,omitempty"`
	DistractionProb float64 `json:"distractionProbability,omitempty"`
	DistractionDur  *Range  `json:"distractionDuration,omitempty"`
}

type IdleOverride struct {
	BaseIdle     *Range `json:"baseIdle,omitempty"`
	BeforeSubmit *Range `json:"beforeSubmit,omitempty"`
}

type Range struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

type Viewport struct {
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
}

type LaunchParams struct {
	Headless         *bool    `json:"headless,omitempty"`
	Stealth          bool     `json:"stealth,omitempty"`
	BlockAds         bool     `json:"blockAds,omitempty"`
	Proxy            string   `json:"proxy,omitempty"`
	Args             []string `json:"args,omitempty"`
	IgnoreDefaultArgs []string `json:"ignoreDefaultArgs,omitempty"`
	UserAgent        string   `json:"userAgent,omitempty"`
	Locale           string   `json:"locale,omitempty"`
	Timezone         string   `json:"timezone,omitempty"`
}

type RetryPolicySpec struct {
	MaxRetries        int      `json:"maxRetries,omitempty"`
	BackoffMs         int      `json:"backoffMs,omitempty"`
	BackoffMultiplier float64  `json:"backoffMultiplier,omitempty"`
	RetryableErrors   []string `json:"retryableErrors,omitempty"`
}

type HealthCheckConfig struct {
	IntervalSeconds int `json:"intervalSeconds,omitempty"`
	TimeoutSeconds  int `json:"timeoutSeconds,omitempty"`
}

type SecretKeyRef struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

type ResourceRequirements struct {
	CPURequest    string `json:"cpuRequest,omitempty"`
	CPULimit      string `json:"cpuLimit,omitempty"`
	MemoryRequest string `json:"memoryRequest,omitempty"`
	MemoryLimit   string `json:"memoryLimit,omitempty"`
}

// ---- Status sub-types ----

type SessionStateSnapshot struct {
	CookieCount      int    `json:"cookieCount,omitempty"`
	LocalStorageKeys int    `json:"localStorageKeys,omitempty"`
	CurrentURL       string `json:"currentURL,omitempty"`
	ViewportWidth    int    `json:"viewportWidth,omitempty"`
	ViewportHeight   int    `json:"viewportHeight,omitempty"`
}

type ActionProgress struct {
	Index int    `json:"index"`
	Total int    `json:"total"`
	Name  string `json:"name,omitempty"`
	Type  string `json:"type,omitempty"`
}

type TaskMetricsStatus struct {
	StartedAt      int64 `json:"startedAt,omitempty"`
	CompletedAt    int64 `json:"completedAt,omitempty"`
	TotalDurationMs int64 `json:"totalDurationMs,omitempty"`
	ActionCount    int   `json:"actionCount,omitempty"`
	IdleTimeMs     int64 `json:"idleTimeMs,omitempty"`
	RetryCount     int   `json:"retryCount,omitempty"`
}

type TaskErrorStatus struct {
	Code        string `json:"code,omitempty"`
	Message     string `json:"message,omitempty"`
	ActionIndex *int   `json:"actionIndex,omitempty"`
	ActionName  string `json:"actionName,omitempty"`
	Recoverable bool   `json:"recoverable,omitempty"`
}

type ActionResult struct {
	Index     int    `json:"index"`
	Name      string `json:"name,omitempty"`
	Type      string `json:"type"`
	Success   bool   `json:"success"`
	DurationMs int64 `json:"durationMs,omitempty"`
	Error     string `json:"error,omitempty"`
	// +kubebuilder:pruning:PreserveUnknownFields
	ExtractedValue map[string]interface{} `json:"extractedValue,omitempty"`
	Timestamp      int64                  `json:"timestamp"`
}

// ---- TaskRecord sub-types ----

type ActionRecord struct {
	Name      string         `json:"name,omitempty"`
	Type      string         `json:"type"`
	Target    *ActionTarget  `json:"target,omitempty"`
	Params    *ActionParams  `json:"params,omitempty"`
	Result    ActionResult   `json:"result"`
}

type TaskResultRecord struct {
	Status  string                 `json:"status"`
	// +kubebuilder:pruning:PreserveUnknownFields
	Output  map[string]interface{} `json:"output,omitempty"`
	Error   *TaskErrorStatus       `json:"error,omitempty"`
	Metrics TaskMetricsStatus      `json:"metrics"`
}
