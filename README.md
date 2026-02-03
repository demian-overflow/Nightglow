# Nightglow

AI-instrumented observability layer with Kafka event streaming and Kubernetes CRDs for browser automation.

Nightglow has two halves: a **TypeScript instrumentation library** that embeds invisible probes into the SmilingFriend automation pipeline, and a **Go Kubernetes operator** that provides CRDs for declarative management of browserless pools, browser sessions, automation tasks, and persistent execution records.

## Architecture

```
                        kubectl apply -f task.yaml
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │   Kubernetes API Server   │
                    └─────────────┬────────────┘
                                  │
                    ┌─────────────▼────────────┐
                    │   Nightglow Operator (Go) │
                    │                           │
                    │  BrowserlessPool ctrl ────┼──▶ Deployment + Service
                    │  BrowserSession ctrl ─────┼──▶ SmilingFriend API
                    │  AutomationTask ctrl ─────┼──▶ Task submission + polling
                    │  TaskRecord creation ─────┼──▶ Persistent history
                    └─────────────┬────────────┘
                                  │ HTTP
                    ┌─────────────▼────────────┐
                    │   SmilingFriend Server     │
                    │  ┌────────────────────┐   │
                    │  │  TaskExecutor       │   │
                    │  │  ActionExecutor     │   │
                    │  │       ↕             │   │
                    │  │  Nightglow Embedder │◀──┼── Instruments (CDP probes)
                    │  └────────────────────┘   │
                    └─────────────┬────────────┘
                                  │ CDP
                    ┌─────────────▼────────────┐
                    │   Browserless Pool        │
                    │   (managed by CRD)        │
                    └──────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
        ┌──────────┐       ┌──────────┐       ┌──────────┐
        │  Kafka   │       │  Tempo   │       │Prometheus│
        │  Topics  │       │  Traces  │       │ Metrics  │
        └──────────┘       └──────────┘       └──────────┘
```

## Components

### Instrumentation Library (TypeScript)

The `src/` directory contains the instrumentation layer that embeds into SmilingFriend. All measurement happens through **Chrome DevTools Protocol** — no scripts are injected into target page DOM, leaving zero detectable footprint.

```
src/
├── types/           # Instrument, Blueprint, Event, Config types
├── instruments/     # Factory (creates from blueprints), Registry, built-in templates
├── kafka/           # EventProducer (buffered + batched), CommandConsumer
├── observability/   # OpenTelemetry traces (Tempo) + metrics (Prometheus)
├── embedder/        # Hooks into action lifecycle phases via CDP
├── nightglow.ts     # Top-level facade
└── index.ts         # Exports
```

### Kubernetes Operator (Go)

The `operator/` directory contains a controller-runtime operator with four CRDs that provide declarative, persistent management of the entire browser automation lifecycle.

```
operator/
├── api/v1alpha1/    # CRD type definitions + DeepCopy
├── controllers/     # BrowserlessPool, BrowserSession, AutomationTask reconcilers
├── internal/        # SmilingFriend HTTP client
├── config/
│   ├── crd/         # CustomResourceDefinition YAML manifests
│   ├── rbac/        # ClusterRole, ClusterRoleBinding, ServiceAccount
│   └── samples/     # Working end-to-end examples
├── cmd/operator/    # Entrypoint
├── Makefile
└── Dockerfile
```

## Quick Start

### Prerequisites

- Kubernetes cluster (or minikube/kind for local dev)
- `kubectl` configured
- Go 1.22+ (for building the operator)
- Node.js 20+ (for the instrumentation library)
- SmilingFriend server running

### Install CRDs

```bash
cd operator
make install
```

### Run the Operator

```bash
# Locally (for development)
make run

# Or build and deploy to cluster
make deploy IMG=nightglow-operator:latest
```

### Deploy a Working Example

```bash
# 1. Create namespaces
kubectl apply -f operator/config/samples/00-namespace.yaml

# 2. Deploy a browserless pool (creates Deployment + Service)
kubectl apply -f operator/config/samples/01-browserless-pool.yaml

# 3. Create a browser session
kubectl apply -f operator/config/samples/02-browser-session.yaml

# 4. Submit a task (navigates to HN, extracts titles, screenshots)
kubectl apply -f operator/config/samples/03-task-navigate-extract.yaml

# Watch everything
kubectl get bpool,bsess,atask,trec -n browser-automation -w
```

### Install Instrumentation Library

```bash
npm install
```

### Start Observability Stack

```bash
# From the BrowserAutomation root (includes Kafka, Tempo, Grafana, Prometheus, OTel collector)
docker compose up -d kafka otel-collector tempo grafana prometheus kafka-ui
```

## CRDs

| Kind | Short Names | Description |
|---|---|---|
| `BrowserlessPool` | `bpool`, `bp` | Manages a Deployment + Service of browserless instances |
| `BrowserSession` | `bsess`, `bs` | A live browser session connected to a pool |
| `AutomationTask` | `atask`, `at` | A task submitted against a session with inline or registered actions |
| `TaskRecord` | `trec`, `tr` | Immutable record of a completed task with full action history |

### Resource Lifecycle

```
BrowserlessPool ──creates──▶ Deployment + Service
       │
       │ referenced by
       ▼
BrowserSession ──creates──▶ Browser session via API
       │
       │ referenced by
       ▼
AutomationTask ──submits──▶ Task via API ──polls──▶ Progress
       │
       │ on completion
       ▼
TaskRecord ──────────────▶ Persistent, immutable execution record
```

## Instrument Kinds

| Kind | What It Measures | Method |
|---|---|---|
| `timing` | Action duration, idle fidelity, TTFB, FCP, LCP | CDP `Performance.getMetrics` |
| `network` | Request count, response bytes, active connections | CDP `Performance.getMetrics` |
| `state` | URL transitions, DOM node count | CDP + puppeteer API |
| `behavioral` | Mouse path length, typing cadence | Automation internals |
| `detection` | `navigator.webdriver`, permission anomalies | CDP `Runtime.evaluate` |
| `composite` | Error snapshots combining multiple data points | Multiple CDP domains |

## Kafka Topics

All prefixed with configurable `topicPrefix` (default: `nightglow`):

| Topic | Content | Volume |
|---|---|---|
| `measurements` | Raw instrument probe data | High |
| `alerts` | Severity warn/critical signals | Low |
| `actions` | Action start/complete/fail events | Medium |
| `tasks` | Task lifecycle events | Low |
| `sessions` | Session create/destroy events | Low |
| `detections` | Bot-detection signals | Low |
| `anomalies` | Behavioral anomaly events | Low |
| `instrument-commands` | Remote enable/disable/reload | Low |

## Configuration

### Instrumentation (TypeScript)

Copy `config/.env.example` and set values:

```bash
cp config/.env.example .env
```

Key variables:

| Variable | Default | Description |
|---|---|---|
| `NIGHTGLOW_KAFKA_BROKERS` | `localhost:9092` | Kafka broker addresses |
| `NIGHTGLOW_KAFKA_TOPIC_PREFIX` | `nightglow` | Topic name prefix |
| `NIGHTGLOW_OTLP_TRACES_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP trace endpoint |
| `NIGHTGLOW_OTLP_METRICS_ENDPOINT` | `http://localhost:4318/v1/metrics` | OTLP metrics endpoint |
| `NIGHTGLOW_AUTO_ENABLE_INSTRUMENTS` | `true` | Register built-in instruments on start |

### Operator (Go)

The operator reads CRD specs directly. No separate configuration file needed. The operator binary accepts these flags:

```
--metrics-bind-address    :8080    Metrics endpoint
--health-probe-bind-address :8081  Health probe endpoint
--leader-elect            false    Enable leader election
```

## Makefile Targets

```bash
make build           # Build operator binary
make run             # Run operator locally
make install         # Apply CRDs to cluster
make uninstall       # Remove CRDs from cluster
make deploy          # Build image + deploy to cluster
make sample-setup    # Apply namespace + pool + session
make sample-extract  # Run the HN extraction task
make sample-login    # Run the login task example
make sample-form     # Run the form fill task example
make watch           # Watch all resources live
make records         # List all TaskRecords
make docker-build    # Build container image
```

## Infrastructure (docker-compose)

The root `docker-compose.yml` includes the full observability stack:

| Service | Port | UI |
|---|---|---|
| Kafka (KRaft) | 9092 | - |
| Kafka UI | 8090 | `http://localhost:8090` |
| OTel Collector | 4317 (gRPC), 4318 (HTTP) | - |
| Tempo | 3200 | - |
| Grafana | 3100 | `http://localhost:3100` |
| Prometheus | 9090 | `http://localhost:9090` |

## Stats

| Component | Language | Lines |
|---|---|---|
| Instrumentation library | TypeScript | 2,219 |
| Operator + CRD types | Go | 2,408 |
| CRD manifests | YAML | 821 |
| Sample manifests | YAML | 270 |
| **Total** | | **~5,700** |
