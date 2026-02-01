import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type Span,
  type Context,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { ObservabilityConfig } from "../types/index.js";

let provider: NodeTracerProvider | null = null;

/**
 * Initialize the OpenTelemetry trace provider.
 * Call once at startup.
 */
export function initTracing(config: ObservabilityConfig): void {
  if (provider) return;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...Object.fromEntries(
      Object.entries(config.resourceAttributes ?? {}).map(([k, v]) => [k, v]),
    ),
  });

  provider = new NodeTracerProvider({ resource });

  if (config.traceEndpoint) {
    const exporter = new OTLPTraceExporter({
      url: config.traceEndpoint,
    });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  }

  provider.register();
}

/**
 * Shutdown the trace provider. Call on process exit.
 */
export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
  }
}

/**
 * Get a Tracer scoped to a Nightglow component.
 */
export function getTracer(component: string): Tracer {
  return trace.getTracer(`nightglow.${component}`);
}

/**
 * Create a span for a task execution.
 */
export function startTaskSpan(
  taskName: string,
  taskId: string,
  sessionId: string,
): { span: Span; ctx: Context } {
  const tracer = getTracer("task");
  const span = tracer.startSpan(`task.${taskName}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      "nightglow.task.id": taskId,
      "nightglow.task.name": taskName,
      "nightglow.session.id": sessionId,
    },
  });
  const ctx = trace.setSpan(context.active(), span);
  return { span, ctx };
}

/**
 * Create a child span for an individual action within a task.
 */
export function startActionSpan(
  parentCtx: Context,
  actionType: string,
  actionIndex: number,
  actionName?: string,
): { span: Span; ctx: Context } {
  const tracer = getTracer("action");
  const span = tracer.startSpan(
    `action.${actionType}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "nightglow.action.type": actionType,
        "nightglow.action.index": actionIndex,
        ...(actionName ? { "nightglow.action.name": actionName } : {}),
      },
    },
    parentCtx,
  );
  const ctx = trace.setSpan(parentCtx, span);
  return { span, ctx };
}

/**
 * Create a child span for an instrument measurement.
 */
export function startInstrumentSpan(
  parentCtx: Context,
  instrumentId: string,
  instrumentName: string,
): { span: Span; ctx: Context } {
  const tracer = getTracer("instrument");
  const span = tracer.startSpan(
    `instrument.${instrumentName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "nightglow.instrument.id": instrumentId,
        "nightglow.instrument.name": instrumentName,
      },
    },
    parentCtx,
  );
  const ctx = trace.setSpan(parentCtx, span);
  return { span, ctx };
}

/**
 * End a span with success.
 */
export function endSpanOk(span: Span): void {
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

/**
 * End a span with error.
 */
export function endSpanError(span: Span, error: Error | string): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: typeof error === "string" ? error : error.message,
  });
  if (error instanceof Error) {
    span.recordException(error);
  }
  span.end();
}

/**
 * Extract trace context (traceId + spanId) from current span.
 */
export function extractTraceContext(span: Span): {
  traceId: string;
  spanId: string;
} {
  const spanCtx = span.spanContext();
  return {
    traceId: spanCtx.traceId,
    spanId: spanCtx.spanId,
  };
}
