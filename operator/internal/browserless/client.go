// Package browserless provides an HTTP client for the SmilingFriend
// browser automation API. Controllers use this to bridge CRD state
// with actual browser session and task lifecycle.
package browserless

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client talks to the SmilingFriend server API.
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
}

// NewClient creates a client targeting the given SmilingFriend base URL.
func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL: baseURL,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// ---------- Sessions ----------

type CreateSessionRequest struct {
	SessionID    string      `json:"sessionId,omitempty"`
	Viewport     *Viewport   `json:"viewport,omitempty"`
	LaunchParams interface{} `json:"launchParams,omitempty"`
	TTL          int64       `json:"ttl,omitempty"`

	// Profile acquisition options
	ProfileID      string `json:"profileId,omitempty"`
	ResourceTreeID string `json:"resourceTreeId,omitempty"`
	WorkerID       string `json:"workerId,omitempty"`
	AcquisitionTTL int64  `json:"acquisitionTtlMs,omitempty"`
}

type Viewport struct {
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
}

type CreateSessionResponse struct {
	SessionID string `json:"sessionId"`
	CreatedAt int64  `json:"createdAt"`

	// Profile acquisition info (when profile was requested)
	AcquisitionID string `json:"acquisitionId,omitempty"`
	ProfileID     string `json:"profileId,omitempty"`
	ProfileName   string `json:"profileName,omitempty"`
}

func (c *Client) CreateSession(ctx context.Context, req CreateSessionRequest) (*CreateSessionResponse, error) {
	var resp CreateSessionResponse
	err := c.post(ctx, "/api/v1/sessions", req, &resp)
	return &resp, err
}

type SessionInfo struct {
	SessionID      string `json:"sessionId"`
	CreatedAt      int64  `json:"createdAt"`
	LastActivityAt int64  `json:"lastActivityAt"`
	Locked         bool   `json:"locked"`
	LockedBy       string `json:"lockedBy,omitempty"`
	CurrentURL     string `json:"currentUrl,omitempty"`
}

func (c *Client) GetSession(ctx context.Context, sessionID string) (*SessionInfo, error) {
	var resp SessionInfo
	err := c.get(ctx, fmt.Sprintf("/api/v1/sessions/%s", sessionID), &resp)
	return &resp, err
}

func (c *Client) DeleteSession(ctx context.Context, sessionID string, deleteStorage bool) error {
	path := fmt.Sprintf("/api/v1/sessions/%s", sessionID)
	if deleteStorage {
		path += "?deleteStorage=true"
	}
	return c.del(ctx, path)
}

func (c *Client) PersistSession(ctx context.Context, sessionID string) error {
	return c.post(ctx, fmt.Sprintf("/api/v1/sessions/%s/persist", sessionID), nil, nil)
}

func (c *Client) SetContext(ctx context.Context, sessionID string, key string, value interface{}) error {
	body := map[string]interface{}{"key": key, "value": value}
	return c.post(ctx, fmt.Sprintf("/api/v1/sessions/%s/context", sessionID), body, nil)
}

// ---------- Tasks ----------

type SubmitTaskRequest struct {
	TaskName       string      `json:"taskName"`
	Input          interface{} `json:"input,omitempty"`
	SessionID      string      `json:"sessionId,omitempty"`
	PersistSession bool        `json:"persistSession,omitempty"`
	IdleProfile    string      `json:"idleProfile,omitempty"`
	Timeout        int64       `json:"timeout,omitempty"`
	WebhookURL     string      `json:"webhookUrl,omitempty"`
}

type SubmitTaskResponse struct {
	TaskID    string `json:"taskId"`
	SessionID string `json:"sessionId"`
	Status    string `json:"status"`
}

func (c *Client) SubmitTask(ctx context.Context, req SubmitTaskRequest) (*SubmitTaskResponse, error) {
	var resp SubmitTaskResponse
	err := c.post(ctx, "/api/v1/tasks", req, &resp)
	return &resp, err
}

type TaskStatus struct {
	TaskID      string      `json:"taskId"`
	TaskName    string      `json:"taskName"`
	SessionID   string      `json:"sessionId"`
	Status      string      `json:"status"`
	Progress    *Progress   `json:"progress,omitempty"`
	Result      *TaskResult `json:"result,omitempty"`
	StartedAt   int64       `json:"startedAt,omitempty"`
	CompletedAt int64       `json:"completedAt,omitempty"`
}

type Progress struct {
	CurrentAction     int    `json:"currentAction"`
	TotalActions      int    `json:"totalActions"`
	CurrentActionName string `json:"currentActionName,omitempty"`
}

type TaskResult struct {
	TaskID    string                 `json:"taskId"`
	SessionID string                 `json:"sessionId"`
	Status    string                 `json:"status"`
	Output    map[string]interface{} `json:"output,omitempty"`
	Error     *TaskError             `json:"error,omitempty"`
	Metrics   *TaskMetrics           `json:"metrics,omitempty"`
}

type TaskError struct {
	Code        string `json:"code"`
	Message     string `json:"message"`
	ActionIndex *int   `json:"actionIndex,omitempty"`
	ActionName  string `json:"actionName,omitempty"`
	Recoverable bool   `json:"recoverable"`
}

type TaskMetrics struct {
	StartedAt       int64 `json:"startedAt"`
	CompletedAt     int64 `json:"completedAt"`
	TotalDurationMs int64 `json:"totalDurationMs"`
	ActionCount     int   `json:"actionCount"`
	IdleTimeMs      int64 `json:"idleTimeMs"`
	RetryCount      int   `json:"retryCount"`
}

func (c *Client) GetTaskStatus(ctx context.Context, taskID string) (*TaskStatus, error) {
	var resp TaskStatus
	err := c.get(ctx, fmt.Sprintf("/api/v1/tasks/%s", taskID), &resp)
	return &resp, err
}

func (c *Client) CancelTask(ctx context.Context, taskID string) error {
	return c.del(ctx, fmt.Sprintf("/api/v1/tasks/%s", taskID))
}

// ---------- Health ----------

type HealthResponse struct {
	Status string `json:"status"`
}

type DetailedHealth struct {
	Status         string             `json:"status"`
	ActiveSessions int                `json:"activeSessions"`
	Browserless    *BrowserlessHealth `json:"browserless,omitempty"`
}

type BrowserlessHealth struct {
	Status          string `json:"status"`
	CurrentSessions int    `json:"currentSessions"`
	MaxSessions     int    `json:"maxSessions"`
}

func (c *Client) Health(ctx context.Context) (*HealthResponse, error) {
	var resp HealthResponse
	err := c.get(ctx, "/health", &resp)
	return &resp, err
}

func (c *Client) DetailedHealth(ctx context.Context) (*DetailedHealth, error) {
	var resp DetailedHealth
	err := c.get(ctx, "/health/detailed", &resp)
	return &resp, err
}

// ---------- HTTP helpers ----------

func (c *Client) get(ctx context.Context, path string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}
	return c.do(req, out)
}

func (c *Client) post(ctx context.Context, path string, body interface{}, out interface{}) error {
	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshaling body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.do(req, out)
}

func (c *Client) del(ctx context.Context, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.BaseURL+path, nil)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}
	return c.do(req, nil)
}

func (c *Client) do(req *http.Request, out interface{}) error {
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	if out != nil && resp.Body != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("decoding response: %w", err)
		}
	}
	return nil
}
