export {
  initTracing,
  shutdownTracing,
  getTracer,
  startTaskSpan,
  startActionSpan,
  startInstrumentSpan,
  endSpanOk,
  endSpanError,
  extractTraceContext,
} from "./tracer.js";

export {
  initMetrics,
  shutdownMetrics,
} from "./metrics.js";

export type { NightglowMetrics } from "./metrics.js";
