import type { ReconcileResult } from "../engine/reconciler/index.js";
import type { StepResult } from "../executor/browser/index.js";

export interface WorkflowLogger {
  taskTransition(result: ReconcileResult): void;
  stepCompleted(taskName: string, result: StepResult): void;
  workflowStarted(workflowName: string): void;
  workflowFinished(workflowName: string, success: boolean): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export class ConsoleLogger implements WorkflowLogger {
  taskTransition(result: ReconcileResult): void {
    console.log(
      `[task:${result.taskName}] ${result.previous} → ${result.current}` +
        (result.error ? ` (${result.error})` : ""),
    );
  }

  stepCompleted(taskName: string, result: StepResult): void {
    const status = result.success ? "ok" : "FAIL";
    console.log(
      `[task:${taskName}] step:${result.step.type} ${status} (${result.durationMs}ms)`,
    );
  }

  workflowStarted(workflowName: string): void {
    console.log(`[workflow:${workflowName}] started`);
  }

  workflowFinished(workflowName: string, success: boolean): void {
    console.log(
      `[workflow:${workflowName}] ${success ? "completed" : "failed"}`,
    );
  }

  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[error] ${message}`, context ?? "");
  }
}
