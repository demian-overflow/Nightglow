import { nanoid } from "nanoid";
import type {
  Instrument,
  InstrumentBlueprint,
  InstrumentProbe,
  ProbeContext,
  ProbeResult,
  AlertCondition,
} from "../types/index.js";
import pino from "pino";

/**
 * Factory that creates Instrument instances from AI-defined blueprints.
 * Each blueprint describes *what* to observe; the factory builds the
 * concrete probe logic that executes within the automation pipeline.
 */
export class InstrumentFactory {
  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger = (logger ?? pino({ level: "info" })).child({
      component: "nightglow.factory",
    });
  }

  /**
   * Build an Instrument from a blueprint.
   * The blueprint's `dataPoints` and `alertConditions` drive the probe generation.
   */
  create(blueprint: InstrumentBlueprint): Instrument {
    const id = nanoid();
    const now = Date.now();

    const probe = this.buildProbe(id, blueprint);

    return {
      id,
      name: this.deriveName(blueprint),
      kind: blueprint.kind,
      phase: blueprint.phase,
      actionFilter: blueprint.actionFilter ?? [],
      enabled: true,
      priority: this.derivePriority(blueprint),
      probe,
      meta: {
        origin: "ai_generated",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  /**
   * Create instrument from a pre-built template with custom probe logic.
   */
  fromTemplate(
    templateName: string,
    overrides: Partial<Omit<Instrument, "id" | "meta">>,
    probe: InstrumentProbe,
  ): Instrument {
    const id = nanoid();
    const now = Date.now();

    return {
      id,
      name: overrides.name ?? templateName,
      kind: overrides.kind ?? "composite",
      phase: overrides.phase ?? "after_action",
      actionFilter: overrides.actionFilter ?? [],
      enabled: overrides.enabled ?? true,
      priority: overrides.priority ?? 50,
      probe,
      meta: {
        origin: "template",
        templateName,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Probe Builders — translate blueprint data points into measurement functions
  // ---------------------------------------------------------------------------

  private buildProbe(instrumentId: string, blueprint: InstrumentBlueprint): InstrumentProbe {
    const collectors = blueprint.dataPoints.map((dp) =>
      this.buildCollector(dp, blueprint.kind),
    );
    const alertChecks = (blueprint.alertConditions ?? []).map((ac) =>
      this.buildAlertCheck(ac),
    );

    return {
      measure: async (ctx: ProbeContext): Promise<ProbeResult> => {
        const data: Record<string, unknown> = {};

        // Run all data collectors
        for (const collector of collectors) {
          try {
            const result = await collector(ctx);
            Object.assign(data, result);
          } catch {
            // Individual collector failure doesn't kill the probe
          }
        }

        // Evaluate alert conditions
        let severity: ProbeResult["severity"] = "trace";
        for (const check of alertChecks) {
          const alertSeverity = check(data);
          if (alertSeverity === "critical") {
            severity = "critical";
            break;
          }
          if (alertSeverity === "warn" && severity !== "critical") {
            severity = "warn";
          }
        }

        return {
          instrumentId,
          timestamp: Date.now(),
          data,
          severity,
          tags: {
            kind: blueprint.kind,
            phase: blueprint.phase,
            sessionId: ctx.sessionId,
            taskId: ctx.taskId,
            ...(ctx.action ? { actionType: ctx.action.type } : {}),
          },
        };
      },
    };
  }

  /**
   * Build a data collector function from a data point descriptor.
   * Data points are strings like:
   *   "action_duration_ms", "request_count", "dom_mutation_count",
   *   "mouse_path_length", "console_errors", "timing.ttfb", etc.
   */
  private buildCollector(
    dataPoint: string,
    kind: string,
  ): (ctx: ProbeContext) => Promise<Record<string, unknown>> {
    // Timing collectors
    if (dataPoint === "action_duration_ms") {
      return async (ctx) => ({
        action_duration_ms:
          ctx.timing?.completedAt && ctx.timing?.startedAt
            ? ctx.timing.completedAt - ctx.timing.startedAt
            : null,
      });
    }

    if (dataPoint === "idle_fidelity") {
      return async (ctx) => ({
        idle_fidelity: ctx.previousResult?.data?.["expected_idle"]
          ? (ctx.timing?.startedAt ?? 0) -
            (ctx.previousResult.data["expected_idle"] as number)
          : null,
      });
    }

    // Network collectors — use CDP for zero page-side footprint
    if (dataPoint === "request_count" || dataPoint === "active_connections") {
      return async (ctx) => {
        try {
          const page = ctx.page as any;
          const cdp = ctx.cdpSession ?? (await page.createCDPSession?.());
          if (!cdp) return { [dataPoint]: null };

          // Query via CDP Performance domain — no page injection
          const { metrics } = await (cdp as any).send("Performance.getMetrics");
          const metric = metrics?.find((m: any) =>
            dataPoint === "request_count"
              ? m.name === "ResourcesSent"
              : m.name === "Connections",
          );
          return { [dataPoint]: metric?.value ?? null };
        } catch {
          return { [dataPoint]: null };
        }
      };
    }

    if (dataPoint === "response_bytes") {
      return async (ctx) => {
        try {
          const page = ctx.page as any;
          const cdp = ctx.cdpSession ?? (await page.createCDPSession?.());
          if (!cdp) return { response_bytes: null };
          const { metrics } = await (cdp as any).send("Performance.getMetrics");
          const metric = metrics?.find((m: any) => m.name === "ReceivedBytes");
          return { response_bytes: metric?.value ?? null };
        } catch {
          return { response_bytes: null };
        }
      };
    }

    // State collectors — use CDP Runtime, no page injection
    if (dataPoint === "current_url") {
      return async (ctx) => {
        try {
          const page = ctx.page as any;
          return { current_url: page.url?.() ?? null };
        } catch {
          return { current_url: null };
        }
      };
    }

    if (dataPoint === "dom_node_count") {
      return async (ctx) => {
        try {
          const page = ctx.page as any;
          const cdp = ctx.cdpSession ?? (await page.createCDPSession?.());
          if (!cdp) return { dom_node_count: null };
          const { counters } = await (cdp as any).send(
            "DOM.getDocument",
            { depth: 0 },
          ).then(() => (cdp as any).send("Performance.getMetrics"))
            .catch(() => ({ counters: null }));
          const metric = counters?.find?.((m: any) => m.name === "Nodes");
          return { dom_node_count: metric?.value ?? null };
        } catch {
          return { dom_node_count: null };
        }
      };
    }

    if (dataPoint === "console_errors") {
      return async () => {
        // Console errors are captured by the continuous console listener
        // which stores them in probe context — this just exposes the count
        return { console_errors: 0 };
      };
    }

    // Behavioral collectors
    if (dataPoint === "mouse_path_length" || dataPoint === "typing_cadence_stddev") {
      return async () => {
        // Behavioral metrics are injected by the embedder from automation internals
        return { [dataPoint]: null };
      };
    }

    // Detection collectors — use CDP to check for known bot-detection signals
    if (dataPoint === "webdriver_flag") {
      return async (ctx) => {
        try {
          const page = ctx.page as any;
          const cdp = ctx.cdpSession ?? (await page.createCDPSession?.());
          if (!cdp) return { webdriver_flag: null };
          const result = await (cdp as any).send("Runtime.evaluate", {
            expression: "navigator.webdriver",
            returnByValue: true,
          });
          return { webdriver_flag: result?.result?.value ?? null };
        } catch {
          return { webdriver_flag: null };
        }
      };
    }

    if (dataPoint === "permissions_anomalies") {
      return async (ctx) => {
        try {
          const page = ctx.page as any;
          const cdp = ctx.cdpSession ?? (await page.createCDPSession?.());
          if (!cdp) return { permissions_anomalies: null };
          const result = await (cdp as any).send("Runtime.evaluate", {
            expression: `(async () => {
              const perms = ['notifications', 'geolocation', 'camera'];
              const results = {};
              for (const p of perms) {
                try {
                  const s = await navigator.permissions.query({ name: p });
                  results[p] = s.state;
                } catch { results[p] = 'error'; }
              }
              return results;
            })()`,
            returnByValue: true,
            awaitPromise: true,
          });
          return { permissions_anomalies: result?.result?.value ?? null };
        } catch {
          return { permissions_anomalies: null };
        }
      };
    }

    // Timing performance collectors via CDP
    if (dataPoint.startsWith("timing.")) {
      const metricName = dataPoint.replace("timing.", "");
      return async (ctx) => {
        try {
          const page = ctx.page as any;
          const cdp = ctx.cdpSession ?? (await page.createCDPSession?.());
          if (!cdp) return { [dataPoint]: null };
          const { metrics } = await (cdp as any).send("Performance.getMetrics");
          const metric = metrics?.find(
            (m: any) => m.name.toLowerCase() === metricName.toLowerCase(),
          );
          return { [dataPoint]: metric?.value ?? null };
        } catch {
          return { [dataPoint]: null };
        }
      };
    }

    // Fallback — unknown data point, return null
    this.logger.warn({ dataPoint, kind }, "Unknown data point — will return null");
    return async () => ({ [dataPoint]: null });
  }

  /**
   * Build an alert check function from an AlertCondition.
   */
  private buildAlertCheck(
    condition: AlertCondition,
  ): (data: Record<string, unknown>) => "warn" | "critical" | null {
    return (data) => {
      const value = data[condition.field];
      if (value === null || value === undefined) return null;

      let triggered = false;
      switch (condition.operator) {
        case "gt":
          triggered = (value as number) > (condition.threshold as number);
          break;
        case "lt":
          triggered = (value as number) < (condition.threshold as number);
          break;
        case "eq":
          triggered = value === condition.threshold;
          break;
        case "neq":
          triggered = value !== condition.threshold;
          break;
        case "contains":
          triggered = String(value).includes(String(condition.threshold));
          break;
        case "regex":
          triggered = new RegExp(String(condition.threshold)).test(String(value));
          break;
      }

      return triggered ? condition.severity : null;
    };
  }

  private deriveName(blueprint: InstrumentBlueprint): string {
    return `${blueprint.kind}:${blueprint.phase}:${blueprint.dataPoints.slice(0, 2).join("+")}`;
  }

  private derivePriority(blueprint: InstrumentBlueprint): number {
    // Detection instruments run first, then timing, then everything else
    switch (blueprint.kind) {
      case "detection": return 10;
      case "timing": return 20;
      case "network": return 30;
      case "state": return 40;
      case "behavioral": return 50;
      case "composite": return 60;
      default: return 50;
    }
  }
}
