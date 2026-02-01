// Nightglow — AI-instrumented observability for browser automation
// =================================================================
//
// Nightglow embeds invisible, AI-generated "instruments" deep into
// the browser automation pipeline. These instruments measure, observe,
// and stream telemetry via Kafka — all without touching the target
// page DOM. Every probe operates through CDP (Chrome DevTools Protocol)
// and puppeteer internals, leaving zero detectable footprint.
//
// Architecture:
//
//   ┌─────────────────────────────────────────────────┐
//   │  SmilingFriend (Browser Automation)              │
//   │  ┌───────────────────────────────────────────┐  │
//   │  │  TaskExecutor → ActionExecutor             │  │
//   │  │       ↕              ↕                     │  │
//   │  │  ┌────────────────────────────────────┐   │  │
//   │  │  │  Nightglow Embedder                │   │  │
//   │  │  │  ├─ before_action probes           │   │  │
//   │  │  │  ├─ after_action probes            │   │  │
//   │  │  │  ├─ on_navigation probes           │   │  │
//   │  │  │  ├─ during_idle probes             │   │  │
//   │  │  │  └─ on_error probes                │   │  │
//   │  │  └────────────┬───────────────────────┘   │  │
//   │  └───────────────┼───────────────────────────┘  │
//   └──────────────────┼──────────────────────────────┘
//                      │
//         ┌────────────┼────────────┐
//         ↓            ↓            ↓
//   ┌──────────┐ ┌──────────┐ ┌──────────┐
//   │  Kafka   │ │  OTel    │ │  Jaeger  │
//   │  Topics  │ │ Metrics  │ │  Traces  │
//   └──────────┘ └──────────┘ └──────────┘
//

export { Nightglow } from "./nightglow.js";
export type { TaskHandle, ActionHandle, ActionContext } from "./nightglow.js";

// Types
export type {
  Instrument,
  InstrumentKind,
  InstrumentPhase,
  InstrumentProbe,
  InstrumentMeta,
  InstrumentBlueprint,
  AlertCondition,
  ProbeContext,
  ProbeResult,
  NightglowEvent,
  NightglowEventType,
  NightglowConfig,
  KafkaConfig,
  ObservabilityConfig,
} from "./types/index.js";

// Instruments
export { InstrumentRegistry } from "./instruments/registry.js";
export { InstrumentFactory } from "./instruments/factory.js";
export { BUILTIN_BLUEPRINTS } from "./instruments/templates.js";

// Kafka
export { EventProducer } from "./kafka/producer.js";
export { CommandConsumer } from "./kafka/consumer.js";
export { TOPICS } from "./kafka/topics.js";

// Observability
export {
  initTracing,
  shutdownTracing,
  initMetrics,
  shutdownMetrics,
} from "./observability/index.js";

// Embedder
export { Embedder } from "./embedder/embedder.js";
export type { EmbedderContext } from "./embedder/embedder.js";
