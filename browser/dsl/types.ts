// ============================================================================
// DSL Types — Declarative browser workflow definition
// ============================================================================

export interface BrowserWorkflow {
  name: string;
  tasks: Task[];
  policy: WorkflowPolicy;
}

export interface Task {
  name: string;
  dependsOn: string[];
  steps: Step[];
  retry: RetryPolicy;
  output: OutputSpec;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type StepType = "navigate" | "waitFor" | "extract" | "click";

export interface StepBase {
  type: StepType;
}

export interface NavigateStep extends StepBase {
  type: "navigate";
  url: string;
}

export interface WaitForStep extends StepBase {
  type: "waitFor";
  selector: string;
  timeoutMs: number;
}

export interface ExtractStep extends StepBase {
  type: "extract";
  selector: string;
  schema: Schema;
}

export interface ClickStep extends StepBase {
  type: "click";
  selector: string;
}

export type Step = NavigateStep | WaitForStep | ExtractStep | ClickStep;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface Schema {
  fields: Field[];
}

export interface Field {
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
}

export interface OutputSpec {
  storeAs: string;
  format: string;
}

export interface WorkflowPolicy {
  maxConcurrentTasks: number;
  timeoutMs: number;
  failFast: boolean;
}
