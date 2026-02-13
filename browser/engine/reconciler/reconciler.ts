import type { Task } from "../../dsl/types.js";
import type { TaskState, TaskStatus } from "./states.js";
import { TERMINAL_STATES, initialStatus } from "./states.js";

export interface ReconcileResult {
  taskName: string;
  previous: TaskState;
  current: TaskState;
  error?: string;
}

/**
 * Drives a single task through the reconciliation state machine.
 * Returns the transition result for each reconcile pass.
 */
export class Reconciler {
  private statuses = new Map<string, TaskStatus>();

  getStatus(taskName: string): TaskStatus | undefined {
    return this.statuses.get(taskName);
  }

  /** Register a task, placing it in Pending state. */
  register(task: Task): void {
    this.statuses.set(task.name, initialStatus());
  }

  /** Advance a task from Pending → Scheduled. */
  schedule(taskName: string): ReconcileResult {
    return this.transition(taskName, "Pending", "Scheduled");
  }

  /** Advance a task from Scheduled → Running. */
  start(taskName: string): ReconcileResult {
    return this.transition(taskName, "Scheduled", "Running");
  }

  /** Mark a running task as succeeded. */
  succeed(taskName: string): ReconcileResult {
    return this.transition(taskName, "Running", "Succeeded");
  }

  /** Mark a running task as failed. Decides Retrying vs Escalated. */
  fail(taskName: string, task: Task, error: string): ReconcileResult {
    const status = this.requireStatus(taskName);
    const previous = status.state;

    if (previous !== "Running") {
      throw new Error(`Cannot fail task "${taskName}" in state "${previous}"`);
    }

    if (status.retryCount < task.retry.maxRetries) {
      status.state = "Retrying";
      status.retryCount++;
      status.lastError = error;
      status.updatedAt = Date.now();
      return { taskName, previous, current: "Retrying", error };
    }

    status.state = "Escalated";
    status.lastError = error;
    status.updatedAt = Date.now();
    return { taskName, previous, current: "Escalated", error };
  }

  /** Move from Retrying back to Running. */
  retry(taskName: string): ReconcileResult {
    return this.transition(taskName, "Retrying", "Running");
  }

  isTerminal(taskName: string): boolean {
    const status = this.statuses.get(taskName);
    return status ? TERMINAL_STATES.has(status.state) : false;
  }

  private transition(
    taskName: string,
    expectedFrom: TaskState,
    to: TaskState,
  ): ReconcileResult {
    const status = this.requireStatus(taskName);
    if (status.state !== expectedFrom) {
      throw new Error(
        `Invalid transition for "${taskName}": expected "${expectedFrom}", got "${status.state}"`,
      );
    }
    const previous = status.state;
    status.state = to;
    status.updatedAt = Date.now();
    return { taskName, previous, current: to };
  }

  private requireStatus(taskName: string): TaskStatus {
    const s = this.statuses.get(taskName);
    if (!s) throw new Error(`Unknown task: "${taskName}"`);
    return s;
  }
}
