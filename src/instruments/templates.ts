import type { InstrumentBlueprint } from "../types/index.js";

/**
 * Built-in instrument blueprints.
 * These are the default instruments that Nightglow ships with.
 * Each blueprint is fed to InstrumentFactory.create() to produce a live Instrument.
 */

/** Measures action execution timing and idle period fidelity */
export const ACTION_TIMING: InstrumentBlueprint = {
  objective: "Track execution timing for every action and measure idle period accuracy",
  kind: "timing",
  phase: "after_action",
  dataPoints: ["action_duration_ms", "idle_fidelity"],
  alertConditions: [
    {
      field: "action_duration_ms",
      operator: "gt",
      threshold: 30000,
      severity: "warn",
      message: "Action took longer than 30s",
    },
  ],
};

/** Monitors network activity via CDP Performance metrics */
export const NETWORK_MONITOR: InstrumentBlueprint = {
  objective: "Observe network request volume and payload sizes per action",
  kind: "network",
  phase: "after_action",
  actionFilter: ["navigate", "click", "clickAndWaitForNavigation"],
  dataPoints: ["request_count", "response_bytes", "active_connections"],
  alertConditions: [
    {
      field: "active_connections",
      operator: "gt",
      threshold: 50,
      severity: "warn",
      message: "High number of active connections detected",
    },
  ],
};

/** Tracks page state transitions after navigation */
export const STATE_TRACKER: InstrumentBlueprint = {
  objective: "Capture page URL and DOM size after navigation events",
  kind: "state",
  phase: "on_navigation",
  actionFilter: ["navigate", "clickAndWaitForNavigation"],
  dataPoints: ["current_url", "dom_node_count"],
};

/** Checks for bot-detection signals at key moments */
export const DETECTION_SENTINEL: InstrumentBlueprint = {
  objective: "Monitor for bot-detection signals like webdriver flag and permission anomalies",
  kind: "detection",
  phase: "after_action",
  actionFilter: ["navigate", "clickAndWaitForNavigation"],
  dataPoints: ["webdriver_flag", "permissions_anomalies"],
  alertConditions: [
    {
      field: "webdriver_flag",
      operator: "eq",
      threshold: true,
      severity: "critical",
      message: "navigator.webdriver is true — bot detection risk",
    },
  ],
};

/** Performance timing from CDP (TTFB, layout duration, etc) */
export const PERFORMANCE_TIMING: InstrumentBlueprint = {
  objective: "Collect browser performance timing metrics via CDP",
  kind: "timing",
  phase: "on_navigation",
  actionFilter: ["navigate", "clickAndWaitForNavigation"],
  dataPoints: [
    "timing.FirstContentfulPaint",
    "timing.DomContentLoaded",
    "timing.LayoutDuration",
    "timing.ScriptDuration",
  ],
};

/** Error-phase instrument to capture state on failure */
export const ERROR_SNAPSHOT: InstrumentBlueprint = {
  objective: "Capture diagnostic data when an action fails",
  kind: "composite",
  phase: "on_error",
  dataPoints: [
    "current_url",
    "dom_node_count",
    "console_errors",
    "webdriver_flag",
  ],
};

/**
 * All built-in blueprints, keyed by name.
 */
export const BUILTIN_BLUEPRINTS: Record<string, InstrumentBlueprint> = {
  "action-timing": ACTION_TIMING,
  "network-monitor": NETWORK_MONITOR,
  "state-tracker": STATE_TRACKER,
  "detection-sentinel": DETECTION_SENTINEL,
  "performance-timing": PERFORMANCE_TIMING,
  "error-snapshot": ERROR_SNAPSHOT,
};
