// ============================================================================
// Instrument Types — AI-crafted behavioral probes embedded in automation
// ============================================================================

/**
 * An Instrument is an AI-generated observability probe that attaches to
 * browser automation actions. Instruments are invisible to the target page
 * and operate entirely within the automation layer (CDP, puppeteer internals,
 * network interception) rather than injecting into page DOM.
 */
export interface Instrument {
  id: string;
  name: string;
  kind: InstrumentKind;
  /** Where in the action lifecycle this instrument fires */
  phase: InstrumentPhase;
  /** Which action types this instrument attaches to (empty = all) */
  actionFilter: string[];
  /** Whether instrument is currently active */
  enabled: boolean;
  /** Instrument priority — lower runs first */
  priority: number;
  /** AI-generated probe logic */
  probe: InstrumentProbe;
  /** Metadata for tracing lineage */
  meta: InstrumentMeta;
}

export type InstrumentKind =
  /** Collects timing data (TTFB, LCP, action duration, idle fidelity) */
  | "timing"
  /** Captures network behavior (request count, payload sizes, failures) */
  | "network"
  /** Observes page state transitions (URL, DOM mutations, console output) */
  | "state"
  /** Tracks behavioral fidelity (mouse paths, typing cadence, scroll patterns) */
  | "behavioral"
  /** Monitors detection signals (fingerprint probes, bot checks, honeypots) */
  | "detection"
  /** Custom composite instrument */
  | "composite";

export type InstrumentPhase =
  | "before_action"
  | "after_action"
  | "during_idle"
  | "on_navigation"
  | "on_error"
  | "continuous";

export interface InstrumentProbe {
  /** The measurement function — receives context, returns structured data */
  measure: (ctx: ProbeContext) => Promise<ProbeResult>;
  /** Optional teardown when instrument is detached */
  teardown?: (ctx: ProbeContext) => Promise<void>;
}

export interface ProbeContext {
  /** Puppeteer page handle (for CDP access) */
  page: unknown;
  /** Current session ID */
  sessionId: string;
  /** Current task ID */
  taskId: string;
  /** Action being executed (if applicable) */
  action?: {
    type: string;
    index: number;
    name?: string;
    target?: unknown;
  };
  /** Timing of the current action */
  timing?: {
    startedAt: number;
    completedAt?: number;
  };
  /** Access to CDP session for low-level measurements */
  cdpSession?: unknown;
  /** Previous probe results from this instrument (for deltas) */
  previousResult?: ProbeResult;
}

export interface ProbeResult {
  instrumentId: string;
  timestamp: number;
  /** Structured measurement data */
  data: Record<string, unknown>;
  /** Severity level for alerting */
  severity: "trace" | "info" | "warn" | "critical";
  /** Tags for filtering and grouping */
  tags: Record<string, string>;
}

export interface InstrumentMeta {
  /** How this instrument was created */
  origin: "ai_generated" | "template" | "manual";
  /** AI model that generated the probe (if applicable) */
  generatedBy?: string;
  /** Template name (if from template) */
  templateName?: string;
  /** Version for hot-reload tracking */
  version: number;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Kafka Event Types
// ============================================================================

export interface NightglowEvent {
  /** Event ID */
  id: string;
  /** Event type discriminator */
  type: NightglowEventType;
  /** Source instrument or system component */
  source: string;
  /** Correlation IDs */
  sessionId: string;
  taskId: string;
  /** Event timestamp */
  timestamp: number;
  /** Event payload */
  payload: Record<string, unknown>;
  /** OpenTelemetry trace context for correlation */
  traceContext?: {
    traceId: string;
    spanId: string;
  };
}

export type NightglowEventType =
  | "instrument.measurement"
  | "instrument.alert"
  | "instrument.lifecycle"
  | "action.started"
  | "action.completed"
  | "action.failed"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "session.created"
  | "session.destroyed"
  | "detection.signal"
  | "behavioral.anomaly";

// ============================================================================
// Kafka Configuration
// ============================================================================

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  /** Topic prefix for all Nightglow topics */
  topicPrefix: string;
  /** Producer configuration */
  producer?: {
    /** Batch size before flush */
    batchSize?: number;
    /** Max wait before flush (ms) */
    lingerMs?: number;
    /** Compression codec */
    compression?: "gzip" | "snappy" | "lz4" | "none";
  };
  /** Consumer configuration (for instrument management) */
  consumer?: {
    groupId?: string;
  };
  /** SSL/SASL auth */
  ssl?: boolean;
  sasl?: {
    mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
    username: string;
    password: string;
  };
}

// ============================================================================
// Observability Configuration
// ============================================================================

export interface ObservabilityConfig {
  /** Service name for traces/metrics */
  serviceName: string;
  /** OTLP endpoint for traces */
  traceEndpoint?: string;
  /** OTLP endpoint for metrics */
  metricsEndpoint?: string;
  /** Sampling rate 0.0 - 1.0 */
  traceSampleRate?: number;
  /** Metrics export interval (ms) */
  metricsInterval?: number;
  /** Additional resource attributes */
  resourceAttributes?: Record<string, string>;
}

// ============================================================================
// Nightglow Top-Level Configuration
// ============================================================================

export interface NightglowConfig {
  kafka: KafkaConfig;
  observability: ObservabilityConfig;
  instruments: {
    /** Directory or registry URL for instrument definitions */
    registryPath?: string;
    /** Auto-enable instruments on registration */
    autoEnable?: boolean;
    /** Max concurrent continuous instruments */
    maxContinuous?: number;
  };
  /** Log level for Nightglow internals */
  logLevel?: "debug" | "info" | "warn" | "error";
}

// ============================================================================
// Instrument Blueprint — AI input for generating instruments
// ============================================================================

export interface InstrumentBlueprint {
  /** What to observe */
  objective: string;
  /** Which kind of instrument */
  kind: InstrumentKind;
  /** When to fire */
  phase: InstrumentPhase;
  /** Filter to specific actions (empty = all) */
  actionFilter?: string[];
  /** What data points to collect */
  dataPoints: string[];
  /** Alert conditions */
  alertConditions?: AlertCondition[];
}

export interface AlertCondition {
  field: string;
  operator: "gt" | "lt" | "eq" | "neq" | "contains" | "regex";
  threshold: unknown;
  severity: "warn" | "critical";
  message: string;
}
