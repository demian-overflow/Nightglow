import type { WorkflowPolicy } from "../dsl/types.js";

export interface BrowserConfig {
  /** Default workflow policy applied when not specified per-workflow */
  defaultPolicy: WorkflowPolicy;
  /** Base URL for the browser backend (browserless / SmilingFriend) */
  browserEndpoint: string;
  /** Artifact storage directory */
  artifactDir: string;
  /** Observability settings */
  observability: {
    enabled: boolean;
    traceEndpoint?: string;
    metricsEndpoint?: string;
  };
  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";
}

export const defaultConfig: BrowserConfig = {
  defaultPolicy: {
    maxConcurrentTasks: 4,
    timeoutMs: 60_000,
    failFast: false,
  },
  browserEndpoint: "ws://localhost:3000",
  artifactDir: "./artifacts",
  observability: {
    enabled: false,
  },
  logLevel: "info",
};
