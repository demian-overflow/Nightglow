import { nanoid } from "nanoid";
import type {
  Instrument,
  InstrumentPhase,
  ProbeContext,
  ProbeResult,
  NightglowEvent,
} from "../types/index.js";
import type { InstrumentRegistry } from "../instruments/registry.js";
import type { EventProducer } from "../kafka/producer.js";
import type { NightglowMetrics } from "../observability/metrics.js";
import {
  startActionSpan,
  startInstrumentSpan,
  endSpanOk,
  endSpanError,
  extractTraceContext,
} from "../observability/tracer.js";
import type { Context, Span } from "@opentelemetry/api";
import pino from "pino";

/**
 * The Embedder hooks Nightglow instruments into the browser automation
 * execution pipeline. It operates at the automation layer — using CDP sessions,
 * puppeteer internals, and execution lifecycle hooks — never injecting
 * scripts into the target page DOM.
 *
 * Integration points:
 * 1. Before/after each action execution
 * 2. During idle periods
 * 3. On navigation events
 * 4. On errors
 * 5. Continuous background probes via CDP
 *
 * All measurement data is:
 *   - Captured via CDP (Chrome DevTools Protocol) or puppeteer API
 *   - Streamed to Kafka via EventProducer
 *   - Correlated via OpenTelemetry traces
 */
export class Embedder {
  private registry: InstrumentRegistry;
  private producer: EventProducer;
  private metrics: NightglowMetrics | null;
  private logger: pino.Logger;

  /** Per-instrument last result cache for delta computations */
  private lastResults = new Map<string, ProbeResult>();

  /** CDP sessions cache per page to avoid re-creation */
  private cdpSessions = new WeakMap<object, unknown>();

  constructor(
    registry: InstrumentRegistry,
    producer: EventProducer,
    metrics: NightglowMetrics | null,
    logger?: pino.Logger,
  ) {
    this.registry = registry;
    this.producer = producer;
    this.metrics = metrics;
    this.logger = (logger ?? pino({ level: "info" })).child({
      component: "nightglow.embedder",
    });
  }

  /**
   * Fire all instruments for a given phase.
   * This is the main hook called from the automation pipeline.
   */
  async firePhase(
    phase: InstrumentPhase,
    context: EmbedderContext,
    parentSpanCtx?: Context,
  ): Promise<ProbeResult[]> {
    const instruments = this.registry.getForPhase(phase, context.action?.type);
    if (instruments.length === 0) return [];

    const results: ProbeResult[] = [];

    for (const instrument of instruments) {
      try {
        const result = await this.executeInstrument(
          instrument,
          context,
          parentSpanCtx,
        );
        if (result) {
          results.push(result);
        }
      } catch (err) {
        this.logger.error(
          { err, instrumentId: instrument.id, phase },
          "Instrument execution failed",
        );
      }
    }

    return results;
  }

  /**
   * Execute a single instrument probe and emit the result.
   */
  private async executeInstrument(
    instrument: Instrument,
    context: EmbedderContext,
    parentSpanCtx?: Context,
  ): Promise<ProbeResult | null> {
    // Create instrument span for tracing
    let span: Span | undefined;
    let spanCtx: Context | undefined;
    if (parentSpanCtx) {
      const s = startInstrumentSpan(parentSpanCtx, instrument.id, instrument.name);
      span = s.span;
      spanCtx = s.ctx;
    }

    try {
      // Obtain or reuse CDP session
      const cdpSession = await this.getCdpSession(context.page);

      const probeCtx: ProbeContext = {
        page: context.page,
        sessionId: context.sessionId,
        taskId: context.taskId,
        action: context.action,
        timing: context.timing,
        cdpSession,
        previousResult: this.lastResults.get(instrument.id),
      };

      const result = await instrument.probe.measure(probeCtx);

      // Cache for delta computations
      this.lastResults.set(instrument.id, result);

      // Update metrics
      this.metrics?.instrumentMeasurements({
        instrumentKind: instrument.kind,
        severity: result.severity,
      });

      if (result.severity === "critical" || result.severity === "warn") {
        this.metrics?.detectionSignals({
          signal: instrument.name,
          severity: result.severity,
        });
      }

      // Emit to Kafka
      const event = this.buildEvent(result, context, span);
      this.producer.emit(event);
      this.metrics?.kafkaEventsEmitted({
        topic: result.severity === "critical" || result.severity === "warn"
          ? "alerts"
          : "measurements",
      });

      if (span) endSpanOk(span);
      return result;
    } catch (err) {
      if (span) endSpanError(span, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /**
   * Convenience: fire before_action instruments.
   */
  async beforeAction(context: EmbedderContext, parentSpanCtx?: Context): Promise<void> {
    await this.firePhase("before_action", context, parentSpanCtx);
  }

  /**
   * Convenience: fire after_action instruments.
   */
  async afterAction(context: EmbedderContext, parentSpanCtx?: Context): Promise<ProbeResult[]> {
    return this.firePhase("after_action", context, parentSpanCtx);
  }

  /**
   * Convenience: fire on_navigation instruments.
   */
  async onNavigation(context: EmbedderContext, parentSpanCtx?: Context): Promise<ProbeResult[]> {
    return this.firePhase("on_navigation", context, parentSpanCtx);
  }

  /**
   * Convenience: fire during_idle instruments.
   */
  async duringIdle(context: EmbedderContext, parentSpanCtx?: Context): Promise<void> {
    await this.firePhase("during_idle", context, parentSpanCtx);
  }

  /**
   * Convenience: fire on_error instruments.
   */
  async onError(context: EmbedderContext, parentSpanCtx?: Context): Promise<ProbeResult[]> {
    return this.firePhase("on_error", context, parentSpanCtx);
  }

  /**
   * Emit a structured task/action lifecycle event (not from an instrument).
   */
  emitLifecycleEvent(
    type: NightglowEvent["type"],
    context: EmbedderContext,
    payload: Record<string, unknown>,
    span?: Span,
  ): void {
    const event: NightglowEvent = {
      id: nanoid(),
      type,
      source: "embedder",
      sessionId: context.sessionId,
      taskId: context.taskId,
      timestamp: Date.now(),
      payload,
      ...(span
        ? { traceContext: extractTraceContext(span) }
        : {}),
    };
    this.producer.emit(event);
  }

  /**
   * Teardown all instruments (call their teardown hooks).
   */
  async teardownAll(context: EmbedderContext): Promise<void> {
    const instruments = this.registry.getAll();
    const cdpSession = await this.getCdpSession(context.page);

    for (const instrument of instruments) {
      if (instrument.probe.teardown) {
        try {
          await instrument.probe.teardown({
            page: context.page,
            sessionId: context.sessionId,
            taskId: context.taskId,
            cdpSession,
          });
        } catch (err) {
          this.logger.warn(
            { err, instrumentId: instrument.id },
            "Instrument teardown failed",
          );
        }
      }
    }

    this.lastResults.clear();
  }

  /**
   * Get or create a CDP session for the given page.
   * CDP sessions are the backbone of undetectable measurement —
   * all probes use CDP protocol commands rather than page.evaluate().
   */
  private async getCdpSession(page: unknown): Promise<unknown> {
    const cached = this.cdpSessions.get(page as object);
    if (cached) return cached;

    try {
      const p = page as any;
      if (typeof p.createCDPSession === "function") {
        const session = await p.createCDPSession();
        // Enable Performance domain for metrics collection
        await session.send("Performance.enable");
        this.cdpSessions.set(page as object, session);
        return session;
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to create CDP session");
    }

    return null;
  }

  private buildEvent(
    result: ProbeResult,
    context: EmbedderContext,
    span?: Span,
  ): NightglowEvent {
    const isAlert = result.severity === "critical" || result.severity === "warn";

    return {
      id: nanoid(),
      type: isAlert ? "instrument.alert" : "instrument.measurement",
      source: result.instrumentId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      timestamp: result.timestamp,
      payload: {
        ...result.data,
        severity: result.severity,
        tags: result.tags,
      },
      ...(span ? { traceContext: extractTraceContext(span) } : {}),
    };
  }
}

/**
 * Context passed to the embedder from the automation pipeline.
 * This is the bridge between SmilingFriend's internal types and Nightglow.
 */
export interface EmbedderContext {
  /** Puppeteer Page instance */
  page: unknown;
  sessionId: string;
  taskId: string;
  taskName?: string;
  action?: {
    type: string;
    index: number;
    name?: string;
    target?: unknown;
  };
  timing?: {
    startedAt: number;
    completedAt?: number;
  };
}
