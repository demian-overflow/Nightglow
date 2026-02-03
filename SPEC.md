# Nightglow Specification

## 1. Overview

Nightglow is a two-layer system:

1. **Instrumentation layer** (TypeScript) — AI-generated observability probes ("instruments") that embed into the SmilingFriend browser automation pipeline. All probes operate through CDP and puppeteer internals. Nothing is injected into the target page DOM.

2. **Kubernetes operator** (Go) — Four CRDs that provide declarative, persistent management of browserless infrastructure, browser sessions, automation tasks, and immutable execution records.

The two layers are independent but complementary. The operator manages lifecycle through Kubernetes; the instrumentation layer streams telemetry through Kafka and OpenTelemetry.

## 2. Instrumentation Layer

### 2.1 Instrument Model

An instrument is an observability probe with a defined lifecycle phase, action filter, and measurement function.

```typescript
interface Instrument {
  id: string;                           // nanoid
  name: string;                         // Derived from blueprint
  kind: InstrumentKind;                 // What domain it measures
  phase: InstrumentPhase;               // When it fires
  actionFilter: string[];               // Which actions trigger it (empty = all)
  enabled: boolean;
  priority: number;                     // Lower runs first
  probe: InstrumentProbe;              // The measurement logic
  meta: InstrumentMeta;                // Lineage tracking
}
```

**Kinds:**

| Kind | Domain | CDP Source |
|---|---|---|
| `timing` | Action duration, idle fidelity, TTFB, FCP, layout duration | `Performance.getMetrics` |
| `network` | Request count, response bytes, active connections | `Performance.getMetrics` |
| `state` | URL, DOM node count, console errors | `DOM.getDocument`, `Runtime.evaluate` |
| `behavioral` | Mouse path length, typing cadence stddev | Automation internals |
| `detection` | `navigator.webdriver`, permission states | `Runtime.evaluate` |
| `composite` | Multi-domain snapshots (e.g., error diagnostics) | Multiple domains |

**Phases:**

| Phase | Trigger Point |
|---|---|
| `before_action` | Before ActionExecutor.execute() |
| `after_action` | After ActionExecutor.execute() returns |
| `during_idle` | During idle periods between actions |
| `on_navigation` | After navigate or clickAndWaitForNavigation actions |
| `on_error` | When an action fails |
| `continuous` | Fires at every phase (background monitoring) |

### 2.2 Instrument Creation

Instruments are created from **blueprints** — declarative descriptions of what to observe.

```typescript
interface InstrumentBlueprint {
  objective: string;                    // Human-readable purpose
  kind: InstrumentKind;
  phase: InstrumentPhase;
  actionFilter?: string[];
  dataPoints: string[];                 // What to measure
  alertConditions?: AlertCondition[];   // When to escalate severity
}
```

The `InstrumentFactory` translates each data point string into a concrete collector function. Known data points:

| Data Point | Kind | Collection Method |
|---|---|---|
| `action_duration_ms` | timing | `timing.completedAt - timing.startedAt` |
| `idle_fidelity` | timing | Delta from expected idle |
| `request_count` | network | CDP `Performance.getMetrics` → `ResourcesSent` |
| `response_bytes` | network | CDP `Performance.getMetrics` → `ReceivedBytes` |
| `active_connections` | network | CDP `Performance.getMetrics` → `Connections` |
| `current_url` | state | `page.url()` |
| `dom_node_count` | state | CDP `Performance.getMetrics` → `Nodes` |
| `console_errors` | state | Console listener count |
| `webdriver_flag` | detection | CDP `Runtime.evaluate` → `navigator.webdriver` |
| `permissions_anomalies` | detection | CDP `Runtime.evaluate` → `navigator.permissions.query` |
| `timing.*` | timing | CDP `Performance.getMetrics` → matched metric name |
| `mouse_path_length` | behavioral | Injected by embedder from automation |
| `typing_cadence_stddev` | behavioral | Injected by embedder from automation |

Unknown data points return `null` with a warning log — they don't crash the probe.

### 2.3 Alert Conditions

Each blueprint can define alert conditions that escalate probe result severity:

```typescript
interface AlertCondition {
  field: string;                        // Key in probe result data
  operator: "gt" | "lt" | "eq" | "neq" | "contains" | "regex";
  threshold: unknown;
  severity: "warn" | "critical";
  message: string;
}
```

When a condition triggers, the `ProbeResult.severity` is escalated from `trace` to `warn` or `critical`. Critical beats warn. Alert-severity results are routed to the Kafka `alerts` topic instead of `measurements`.

### 2.4 Built-in Instruments

Six instrument blueprints ship by default and are auto-registered on `Nightglow.start()`:

| Name | Kind | Phase | Data Points |
|---|---|---|---|
| `action-timing` | timing | after_action | `action_duration_ms`, `idle_fidelity` |
| `network-monitor` | network | after_action | `request_count`, `response_bytes`, `active_connections` |
| `state-tracker` | state | on_navigation | `current_url`, `dom_node_count` |
| `detection-sentinel` | detection | after_action | `webdriver_flag`, `permissions_anomalies` |
| `performance-timing` | timing | on_navigation | `timing.FirstContentfulPaint`, `timing.DomContentLoaded`, `timing.LayoutDuration`, `timing.ScriptDuration` |
| `error-snapshot` | composite | on_error | `current_url`, `dom_node_count`, `console_errors`, `webdriver_flag` |

### 2.5 Embedder

The `Embedder` is the bridge between SmilingFriend's execution pipeline and Nightglow's instruments. It fires instruments at the correct lifecycle phase, manages CDP sessions, caches previous results for delta computation, and emits events to Kafka.

**CDP session strategy:** The embedder creates one CDP session per puppeteer `Page` and caches it with a `WeakMap`. The CDP `Performance` domain is enabled on creation. All probes reuse this session — no new sessions are created per probe.

**Integration with SmilingFriend TaskExecutor:**

```
TaskExecutor.execute()
  │
  ├── nightglow.beginTask(taskName, taskId, sessionId)
  │     └── Creates OpenTelemetry task span
  │     └── Emits task.started to Kafka
  │
  ├── For each action:
  │   ├── actionHandle = nightglow.beforeAction(handle, {type, index, page})
  │   │     └── Creates action span (child of task span)
  │   │     └── Fires before_action instruments
  │   │     └── Emits action.started to Kafka
  │   │
  │   ├── result = actionExecutor.execute(action, context)
  │   │
  │   ├── nightglow.afterAction(handle, actionHandle, result.success)
  │   │     └── Fires after_action instruments
  │   │     └── Fires on_navigation instruments (for nav actions)
  │   │     └── OR fires on_error instruments (on failure)
  │   │     └── Emits action.completed or action.failed
  │   │     └── Records duration in metrics histogram
  │   │     └── Ends action span
  │   │
  │   └── nightglow.duringIdle(handle, page, idleDurationMs)
  │         └── Fires during_idle instruments
  │         └── Records idle duration in metrics histogram
  │
  └── nightglow.endTask(handle, status)
        └── Emits task.completed or task.failed
        └── Ends task span
```

### 2.6 Kafka Event Stream

All events conform to:

```typescript
interface NightglowEvent {
  id: string;                           // nanoid
  type: NightglowEventType;
  source: string;                       // Instrument ID or "embedder"
  sessionId: string;
  taskId: string;
  timestamp: number;
  payload: Record<string, unknown>;
  traceContext?: {
    traceId: string;
    spanId: string;
  };
}
```

**Routing:** Event type prefix determines topic:

| Prefix | Topic |
|---|---|
| `instrument.measurement` | `{prefix}.measurements` |
| `instrument.alert` | `{prefix}.alerts` |
| `instrument.lifecycle` | `{prefix}.instrument-commands` |
| `action.*` | `{prefix}.actions` |
| `task.*` | `{prefix}.tasks` |
| `session.*` | `{prefix}.sessions` |
| `detection.*` | `{prefix}.detections` |
| `behavioral.*` | `{prefix}.anomalies` |

**Producer buffering:** Events are buffered in memory and flushed when either the batch size (default 50) is reached or the linger timer (default 500ms) fires. Messages are keyed by `sessionId` for partition co-location. Failed batches are returned to the front of the buffer for retry.

**Consumer:** The `CommandConsumer` listens on the `instrument-commands` topic for remote instrument management (enable, disable, reload, update_config).

### 2.7 OpenTelemetry

**Traces:** Three-level span hierarchy: `task.{name}` → `action.{type}` → `instrument.{name}`. Each span carries attributes like `nightglow.task.id`, `nightglow.action.index`, `nightglow.instrument.id`. Trace context (`traceId` + `spanId`) is attached to every Kafka event for end-to-end correlation.

**Metrics:** Exported via OTLP to the collector, which exposes them as Prometheus metrics.

| Metric | Type | Labels |
|---|---|---|
| `nightglow.tasks.total` | Counter | `taskName`, `status` |
| `nightglow.actions.duration_ms` | Histogram | `actionType`, `taskName` |
| `nightglow.idle.duration_ms` | Histogram | `taskName` |
| `nightglow.instruments.measurements_total` | Counter | `instrumentKind`, `severity` |
| `nightglow.instruments.active` | UpDownCounter | — |
| `nightglow.kafka.events_total` | Counter | `topic` |
| `nightglow.detections.signals_total` | Counter | `signal`, `severity` |

## 3. Kubernetes Operator

### 3.1 API Group

```
Group:   nightglow.orderout.io
Version: v1alpha1
```

### 3.2 BrowserlessPool

Manages a fleet of browserless browser instances as a Kubernetes Deployment + ClusterIP Service.

**Spec:**

| Field | Type | Default | Description |
|---|---|---|---|
| `image` | string | `ghcr.io/browserless/multi:latest` | Container image |
| `replicas` | int32 | 1 | Number of browserless pods |
| `concurrent` | int32 | 10 | Max concurrent sessions per pod |
| `token` | string | — | API authentication token |
| `tokenSecretRef` | SecretKeyRef | — | Token from a Secret (overrides `token`) |
| `port` | int32 | 3000 | Service port |
| `stealth` | bool | false | Enable stealth endpoint |
| `resources` | ResourceRequirements | — | CPU/memory requests and limits |
| `healthCheck` | HealthCheckConfig | — | Probe timing configuration |

**Status:**

| Field | Description |
|---|---|
| `phase` | `Pending`, `Running`, `Degraded`, `Failed` |
| `readyReplicas` | Count of healthy browserless pods |
| `activeSessions` | Total sessions across all replicas |
| `endpoint` | Internal WebSocket URL (`ws://{name}.{ns}.svc:{port}`) |
| `httpEndpoint` | Internal HTTP URL (`http://{name}.{ns}.svc:{port}`) |

**Reconciliation:**
1. Build Deployment spec from pool spec (image, replicas, env vars, probes, resources)
2. CreateOrUpdate Deployment with owner reference
3. Build Service spec (ClusterIP, port mapping)
4. CreateOrUpdate Service with owner reference
5. Read Deployment status → update pool status (readyReplicas, phase, endpoints)

**Owned resources:** The controller sets `ownerReferences` on both Deployment and Service. Deleting the pool cascades to both.

### 3.3 BrowserSession

Manages a live browser session connected to a pool through the SmilingFriend API.

**Spec:**

| Field | Type | Default | Description |
|---|---|---|---|
| `poolRef` | string | **required** | Name of the BrowserlessPool |
| `viewport` | Viewport | — | Browser viewport dimensions |
| `launchParams` | LaunchParams | — | Browserless launch parameters |
| `ttl` | int64 | 300 | Session TTL in seconds (0 = no expiry) |
| `persistent` | bool | false | Persist state to storage on close |
| `idleProfile` | string | `casual` | Default idle profile preset |
| `restoreFrom` | string | — | Session name to restore state from |

**Status:**

| Field | Description |
|---|---|
| `phase` | `Pending`, `Active`, `Locked`, `Persisted`, `Expired`, `Failed` |
| `sessionID` | Internal session ID from SmilingFriend |
| `currentURL` | Current browser URL |
| `lockedBy` | Name of the AutomationTask holding the lock |
| `state` | Snapshot: cookie count, localStorage key count, viewport |
| `lastActivityAt` | Unix ms timestamp |

**Lifecycle state machine:**

```
            create
Pending ──────────▶ Active ◀──────── task completes
   │                  │                     │
   │  pool not ready  │  task submitted     │  persistent=true
   ▼                  ▼                     ▼
Pending          Locked ─────────▶ Active / Persisted
                                        │
                                        │ TTL expires
                                        ▼
                                     Expired
```

**Reconciliation:**
1. Resolve referenced BrowserlessPool (must be `Running`)
2. On `Pending`: POST to SmilingFriend `/api/v1/sessions` with viewport/launchParams/TTL
3. On `Active`: GET session info, update currentURL/lockedBy, check TTL
4. On `Locked`: Requeue every 5s (waiting for task to finish)
5. On deletion: DELETE session from SmilingFriend (optionally delete storage)

### 3.4 AutomationTask

Submits a task against a session, polls for progress, logs every action, and creates a TaskRecord on completion.

**Spec:**

| Field | Type | Default | Description |
|---|---|---|---|
| `taskName` | string | **required** | Registered task definition or `custom` |
| `sessionRef` | string | **required** | Name of the BrowserSession |
| `input` | object | — | Task-specific input (arbitrary JSON) |
| `actions` | []ActionSpec | — | Inline action sequence (for `custom` tasks) |
| `idleProfile` | string | — | Override session idle profile |
| `customIdleProfile` | IdleProfileSpec | — | Full custom timing (when `idleProfile=custom`) |
| `timeout` | int64 | 120 | Timeout in seconds |
| `retryPolicy` | RetryPolicySpec | — | Retry configuration |
| `persistSession` | bool | true | Persist session after completion |
| `webhookUrl` | string | — | Callback URL on completion |
| `recordRef` | string | — | Custom name for the TaskRecord |

**ActionSpec:**

Each action maps directly to SmilingFriend's `ActionDefinition`:

```yaml
actions:
  - name: "Navigate to page"          # Human-readable label
    type: navigate                     # ActionType enum
    target:                            # Element targeting
      selector: ".my-class"
      xpath: "//div[@id='foo']"
      text: "Click me"
      role: "button"
      testId: "submit-btn"
      coordinates: { x: 100, y: 200 }
    params:                            # Action-specific parameters
      url: "https://example.com"
      text: "hello"
      key: "Enter"
      # ... all ActionParams fields
    assertion:                         # Post-action validation
      type: visible
      selector: ".success"
      timeout: 5000
    onFailure: retry                   # abort|skip|retry|fallback
    idleOverride:                      # Per-action timing override
      baseIdle: { min: 200, max: 500 }
      beforeSubmit: { min: 1000, max: 3000 }
```

**Status:**

| Field | Description |
|---|---|
| `phase` | `Pending`, `Running`, `Completed`, `Failed`, `Timeout`, `Cancelled` |
| `taskID` | Internal task ID from SmilingFriend |
| `progress` | Human-readable `current/total` (e.g., `3/6`) |
| `currentAction` | Index, total, name, type of the action being executed |
| `metrics` | startedAt, completedAt, totalDurationMs, actionCount, idleTimeMs, retryCount |
| `output` | Task output (arbitrary JSON) |
| `error` | Code, message, actionIndex, actionName, recoverable |
| `recordRef` | Name of the created TaskRecord |
| `actionLog` | Array of per-action results logged during execution |

**actionLog entry:**

```yaml
actionLog:
  - index: 0
    name: "Navigate to page"
    type: navigate
    success: true
    durationMs: 1523
    timestamp: 1706745600000
  - index: 1
    name: "Extract title"
    type: extract
    success: true
    durationMs: 45
    extractedValue:
      text: "Hello World"
    timestamp: 1706745602000
```

**Reconciliation:**
1. On `Pending`:
   - Resolve BrowserSession (must be `Active` or `Persisted`)
   - Resolve BrowserlessPool through session's `poolRef`
   - POST to SmilingFriend `/api/v1/tasks`
   - Lock session (set session phase to `Locked`, `lockedBy` to task name)
   - Set task phase to `Running`
2. On `Running`:
   - Poll GET `/api/v1/tasks/{id}` every 2 seconds
   - Update progress and currentAction
   - Append new actions to `actionLog`
   - On terminal status: transition to completion handler
3. On completion (`Completed`/`Failed`/`Timeout`):
   - Copy metrics, output, error from API response to task status
   - Unlock session
   - Create TaskRecord
4. On `Cancelled`:
   - DELETE task on SmilingFriend
   - Unlock session

### 3.5 TaskRecord

Immutable, persistent record of a completed task execution. Created automatically by the AutomationTask controller. Contains the full action sequence with per-action results, timing, and extracted values.

**Spec (no status subresource — records are immutable):**

| Field | Type | Description |
|---|---|---|
| `taskName` | string | Task definition name |
| `sessionRef` | string | Session used |
| `taskRef` | string | AutomationTask name that created this record |
| `input` | object | Input that was provided |
| `actions` | []ActionRecord | Full action list with per-action results |
| `result` | TaskResultRecord | Outcome: status, output, error, metrics |
| `startedAt` | int64 | Unix ms |
| `completedAt` | int64 | Unix ms |

**ActionRecord:**

Each entry pairs the action definition (name, type, target, params) with its execution result (success, duration, extracted value, error).

**Labels applied automatically:**

```yaml
labels:
  nightglow.orderout.io/task-name: login
  nightglow.orderout.io/session: login-session
  nightglow.orderout.io/task: login-task-001
  nightglow.orderout.io/status: completed
```

These labels enable querying execution history:

```bash
# All records for a specific task definition
kubectl get trec -l nightglow.orderout.io/task-name=login

# All failed records
kubectl get trec -l nightglow.orderout.io/status=failed

# All records for a session
kubectl get trec -l nightglow.orderout.io/session=login-session
```

**Owner references:** TaskRecords have an owner reference to the creating AutomationTask. Deleting the task cascades to its record. To preserve records independently, remove the owner reference after creation.

## 4. SmilingFriend HTTP Client

The operator communicates with SmilingFriend through an internal Go HTTP client (`internal/browserless/client.go`). All controller actions are API calls, not direct browser manipulation.

**Endpoints used:**

| Method | Path | Used By |
|---|---|---|
| POST | `/api/v1/sessions` | BrowserSession controller |
| GET | `/api/v1/sessions/{id}` | BrowserSession controller |
| DELETE | `/api/v1/sessions/{id}` | BrowserSession controller |
| POST | `/api/v1/sessions/{id}/persist` | BrowserSession controller |
| POST | `/api/v1/sessions/{id}/context` | BrowserSession controller |
| POST | `/api/v1/tasks` | AutomationTask controller |
| GET | `/api/v1/tasks/{id}` | AutomationTask controller |
| DELETE | `/api/v1/tasks/{id}` | AutomationTask controller |
| GET | `/health` | BrowserlessPool controller |
| GET | `/health/detailed` | BrowserlessPool controller |

## 5. Observability Infrastructure

### 5.1 Pipeline

```
Nightglow Instrumentation
    │
    ├── OpenTelemetry SDK ──▶ OTLP HTTP ──▶ OTel Collector
    │                                           │
    │                                    ┌──────┴──────┐
    │                                    ▼             ▼
    │                                  Tempo      Prometheus
    │                               (traces)      (metrics)
    │
    └── KafkaJS Producer ──▶ Kafka Broker
                                │
                          ┌─────┴─────────┐
                          ▼               ▼
                     measurements    alerts
                     actions         detections
                     tasks           anomalies
                     sessions        instrument-commands
```

### 5.2 OTel Collector Configuration

The collector receives OTLP (gRPC on 4317, HTTP on 4318), batches with a 5s timeout and 1024 batch size, limits memory to 512 MiB, and exports to:

- **Tempo** (OTLP gRPC on port 4317) — for traces
- **Prometheus** (scrape endpoint on port 8889, namespace `nightglow`) — for metrics
- **Kafka** (topic `nightglow.otel-export`, OTLP JSON encoding) — for downstream processing

### 5.3 Prometheus Scrape Targets

| Job | Target | Description |
|---|---|---|
| `nightglow-otel` | `otel-collector:8889` | Nightglow metrics via OTel exporter |
| `otel-collector` | `otel-collector:8888` | Collector's own health metrics |

## 6. Security Model

- **CDP-only probes:** No JavaScript is injected into the target page. All measurement uses Chrome DevTools Protocol commands sent through the puppeteer CDP session. This means:
  - No `<script>` tags added to pages
  - No `page.evaluate()` calls from instruments (only from user-defined `evaluate` actions)
  - No MutationObservers or event listeners attached to page DOM
  - No modifications to `window`, `navigator`, or other global objects

- **Operator RBAC:** Least-privilege ClusterRole with access only to Nightglow CRDs, Deployments, Services, Secrets (read-only), and Events.

- **Kafka authentication:** Optional SASL (plain, scram-sha-256, scram-sha-512) and SSL configuration in `KafkaConfig`.

- **Secret references:** BrowserlessPool tokens can reference Kubernetes Secrets via `tokenSecretRef` instead of inline `token`.

## 7. Error Codes

Inherited from SmilingFriend and propagated through TaskRecord:

| Code | Recoverable | Description |
|---|---|---|
| `ELEMENT_NOT_FOUND` | Yes | Target element not found in DOM |
| `TIMEOUT` | Yes | Action or wait exceeded timeout |
| `NAVIGATION_FAILED` | Yes | Page navigation failed |
| `ASSERTION_FAILED` | No | Post-action assertion did not pass |
| `SESSION_EXPIRED` | No | Browser session no longer exists |
| `BROWSERLESS_UNAVAILABLE` | Yes | Cannot connect to browserless |
| `RATE_LIMITED` | Yes | Target site rate limiting |
| `CAPTCHA_DETECTED` | No | CAPTCHA challenge detected |
| `BLOCKED` | No | Bot detection triggered |
| `INVALID_INPUT` | No | Task input validation failed |
| `INTERNAL_ERROR` | No | Unexpected internal error |

## 8. Idle Profile Presets

Applied between actions to simulate human cognitive delays:

| Preset | baseIdle | afterNav | afterClick | readingWPM | distractionProb |
|---|---|---|---|---|---|
| `casual` | 300-800ms | 1000-3000ms | 200-600ms | 200 | 5% |
| `focused` | 150-400ms | 500-1500ms | 100-300ms | 300 | 1% |
| `rushed` | 50-200ms | 200-800ms | 50-150ms | 400 | 0% |
| `methodical` | 500-1200ms | 1500-4000ms | 300-800ms | 150 | 8% |

Custom profiles can be defined inline per-task via `customIdleProfile` with full control over all timing ranges, reading speed, and distraction parameters.
