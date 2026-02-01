import type { NightglowConfig, InstrumentBlueprint, NightglowEvent } from "./types/index.js";
import { InstrumentRegistry } from "./instruments/registry.js";
import { InstrumentFactory, } from "./instruments/factory.js";
import { BUILTIN_BLUEPRINTS } from "./instruments/templates.js";
import { EventProducer } from "./kafka/producer.js";
import { CommandConsumer } from "./kafka/consumer.js";
import { Embedder, type EmbedderContext } from "./embedder/embedder.js";
import {
  initTracing,
  shutdownTracing,
  initMetrics,
  shutdownMetrics,
  startTaskSpan,
  startActionSpan,
  endSpanOk,
  endSpanError,
  extractTraceContext,
} from "./observability/index.js";
import type { NightglowMetrics } from "./observability/index.js";
import type { Context, Span } from "@opentelemetry/api";
import pino from "pino";

/**
 * Nightglow — the top-level facade.
 *
 * Usage:
 *   const glow = new Nightglow(config);
 *   await glow.start();
 *
 *   // In your task executor, wrap action execution:
 *   const taskCtx = glow.beginTask("login", taskId, sessionId);
 *   await glow.beforeAction(taskCtx, { type: "click", index: 0, page });
 *   // ... execute action ...
 *   await glow.afterAction(taskCtx, { type: "click", index: 0, page, timing });
 *   glow.endTask(taskCtx);
 *
 *   await glow.shutdown();
 */
export class Nightglow {
  private config: NightglowConfig;
  private logger: pino.Logger;
  private registry: InstrumentRegistry;
  private factory: InstrumentFactory;
  private producer: EventProducer;
  private consumer: CommandConsumer;
  private embedder: Embedder;
  private metrics: NightglowMetrics | null = null;
  private started = false;

  constructor(config: NightglowConfig) {
    this.config = config;
    this.logger = pino({ level: config.logLevel ?? "info" }).child({
      component: "nightglow",
    });

    this.registry = new InstrumentRegistry(this.logger);
    this.factory = new InstrumentFactory(this.logger);
    this.producer = new EventProducer(config.kafka, this.logger);
    this.consumer = new CommandConsumer(config.kafka, this.logger);
    this.embedder = new Embedder(this.registry, this.producer, null, this.logger);
  }

  /**
   * Start Nightglow: connect Kafka, init tracing/metrics, register built-in instruments.
   */
  async start(): Promise<void> {
    if (this.started) return;

    this.logger.info("Starting Nightglow...");

    // Init observability
    initTracing(this.config.observability);
    this.metrics = initMetrics(this.config.observability);

    // Rebuild embedder with metrics
    this.embedder = new Embedder(
      this.registry,
      this.producer,
      this.metrics,
      this.logger,
    );

    // Connect Kafka
    await this.producer.connect();

    // Register built-in instruments
    if (this.config.instruments.autoEnable !== false) {
      this.registerBuiltinInstruments();
    }

    // Start command consumer for remote instrument management
    this.consumer.onCommand(async (cmd) => {
      switch (cmd.action) {
        case "enable":
          this.registry.enable(cmd.instrumentId);
          break;
        case "disable":
          this.registry.disable(cmd.instrumentId);
          break;
        case "reload":
          // Reload could re-create from blueprint
          this.logger.info({ id: cmd.instrumentId }, "Instrument reload requested");
          break;
        case "update_config":
          this.logger.info(
            { id: cmd.instrumentId, payload: cmd.payload },
            "Instrument config update requested",
          );
          break;
      }
    });

    await this.consumer.start();

    this.started = true;
    this.logger.info(
      { instruments: this.registry.activeCount },
      "Nightglow started",
    );
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (!this.started) return;

    this.logger.info("Shutting down Nightglow...");

    await this.consumer.stop();
    await this.producer.disconnect();
    await shutdownTracing();
    await shutdownMetrics();

    this.started = false;
    this.logger.info("Nightglow shut down");
  }

  // ---------------------------------------------------------------------------
  // Task lifecycle — called from the automation pipeline
  // ---------------------------------------------------------------------------

  /**
   * Begin tracing a task. Returns a handle used for all subsequent calls.
   */
  beginTask(taskName: string, taskId: string, sessionId: string): TaskHandle {
    const { span, ctx } = startTaskSpan(taskName, taskId, sessionId);

    this.embedder.emitLifecycleEvent(
      "task.started",
      { page: null, sessionId, taskId, taskName },
      { taskName },
      span,
    );

    this.metrics?.taskCount({ taskName, status: "started" });

    return { taskName, taskId, sessionId, span, ctx };
  }

  /**
   * End a task trace.
   */
  endTask(handle: TaskHandle, status: "completed" | "failed" = "completed"): void {
    this.embedder.emitLifecycleEvent(
      status === "completed" ? "task.completed" : "task.failed",
      { page: null, sessionId: handle.sessionId, taskId: handle.taskId, taskName: handle.taskName },
      { status },
      handle.span,
    );

    this.metrics?.taskCount({ taskName: handle.taskName, status });

    if (status === "completed") {
      endSpanOk(handle.span);
    } else {
      endSpanError(handle.span, "Task failed");
    }
  }

  // ---------------------------------------------------------------------------
  // Action lifecycle — wraps individual actions with instrument probes
  // ---------------------------------------------------------------------------

  /**
   * Call before executing an action. Fires before_action instruments.
   */
  async beforeAction(
    handle: TaskHandle,
    ctx: ActionContext,
  ): Promise<ActionHandle> {
    const { span, ctx: spanCtx } = startActionSpan(
      handle.ctx,
      ctx.type,
      ctx.index,
      ctx.name,
    );

    const startedAt = Date.now();

    const embedCtx: EmbedderContext = {
      page: ctx.page,
      sessionId: handle.sessionId,
      taskId: handle.taskId,
      taskName: handle.taskName,
      action: { type: ctx.type, index: ctx.index, name: ctx.name, target: ctx.target },
      timing: { startedAt },
    };

    this.embedder.emitLifecycleEvent("action.started", embedCtx, {
      actionType: ctx.type,
      actionIndex: ctx.index,
    }, span);

    await this.embedder.beforeAction(embedCtx, spanCtx);

    return { span, ctx: spanCtx, embedCtx, startedAt };
  }

  /**
   * Call after an action completes. Fires after_action + on_navigation instruments.
   */
  async afterAction(
    handle: TaskHandle,
    actionHandle: ActionHandle,
    success: boolean,
  ): Promise<void> {
    const completedAt = Date.now();
    const duration = completedAt - actionHandle.startedAt;

    actionHandle.embedCtx.timing = {
      startedAt: actionHandle.startedAt,
      completedAt,
    };

    this.metrics?.actionDuration(duration, {
      actionType: actionHandle.embedCtx.action?.type ?? "unknown",
      taskName: handle.taskName,
    });

    if (success) {
      await this.embedder.afterAction(actionHandle.embedCtx, actionHandle.ctx);

      // Fire navigation instruments for navigation-type actions
      const navActions = ["navigate", "clickAndWaitForNavigation"];
      if (navActions.includes(actionHandle.embedCtx.action?.type ?? "")) {
        await this.embedder.onNavigation(actionHandle.embedCtx, actionHandle.ctx);
      }

      this.embedder.emitLifecycleEvent("action.completed", actionHandle.embedCtx, {
        durationMs: duration,
        success: true,
      }, actionHandle.span);

      endSpanOk(actionHandle.span);
    } else {
      await this.embedder.onError(actionHandle.embedCtx, actionHandle.ctx);

      this.embedder.emitLifecycleEvent("action.failed", actionHandle.embedCtx, {
        durationMs: duration,
        success: false,
      }, actionHandle.span);

      endSpanError(actionHandle.span, "Action failed");
    }
  }

  /**
   * Fire during-idle instruments (called between actions).
   */
  async duringIdle(
    handle: TaskHandle,
    page: unknown,
    idleDurationMs: number,
  ): Promise<void> {
    const embedCtx: EmbedderContext = {
      page,
      sessionId: handle.sessionId,
      taskId: handle.taskId,
      taskName: handle.taskName,
    };

    this.metrics?.idleDuration(idleDurationMs, { taskName: handle.taskName });
    await this.embedder.duringIdle(embedCtx, handle.ctx);
  }

  // ---------------------------------------------------------------------------
  // Instrument management
  // ---------------------------------------------------------------------------

  /**
   * Register a custom instrument from a blueprint.
   */
  addInstrument(blueprint: InstrumentBlueprint): string {
    const instrument = this.factory.create(blueprint);
    this.registry.register(instrument);
    return instrument.id;
  }

  /**
   * Enable/disable an instrument by ID.
   */
  enableInstrument(id: string): boolean {
    return this.registry.enable(id);
  }

  disableInstrument(id: string): boolean {
    return this.registry.disable(id);
  }

  /**
   * Remove an instrument entirely.
   */
  removeInstrument(id: string): boolean {
    return this.registry.unregister(id);
  }

  /**
   * Get registry stats.
   */
  get instrumentStats(): { active: number; total: number } {
    return {
      active: this.registry.activeCount,
      total: this.registry.totalCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Direct event emission (for custom events)
  // ---------------------------------------------------------------------------

  /**
   * Emit a raw Nightglow event to Kafka.
   */
  emit(event: NightglowEvent): void {
    this.producer.emit(event);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private registerBuiltinInstruments(): void {
    for (const [name, blueprint] of Object.entries(BUILTIN_BLUEPRINTS)) {
      const instrument = this.factory.create(blueprint);
      this.registry.register(instrument);
      this.logger.debug({ name, id: instrument.id }, "Registered built-in instrument");
    }
  }
}

// ---------------------------------------------------------------------------
// Handle types for task/action lifecycle tracking
// ---------------------------------------------------------------------------

export interface TaskHandle {
  taskName: string;
  taskId: string;
  sessionId: string;
  span: Span;
  ctx: Context;
}

export interface ActionHandle {
  span: Span;
  ctx: Context;
  embedCtx: EmbedderContext;
  startedAt: number;
}

export interface ActionContext {
  type: string;
  index: number;
  name?: string;
  target?: unknown;
  page: unknown;
}
