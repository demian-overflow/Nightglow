import type { WorkflowPolicy, RetryPolicy } from "../dsl/types.js";

/**
 * Evaluates workflow and retry policies to make scheduling decisions.
 */
export class PolicyEngine {
  constructor(private readonly workflowPolicy: WorkflowPolicy) {}

  /** Whether another concurrent task can be started. */
  canSchedule(currentRunning: number): boolean {
    return currentRunning < this.workflowPolicy.maxConcurrentTasks;
  }

  /** Whether a failed task should be retried. */
  shouldRetry(retryPolicy: RetryPolicy, attempt: number): boolean {
    return attempt < retryPolicy.maxRetries;
  }

  /** Compute backoff delay for a retry attempt. */
  backoffMs(retryPolicy: RetryPolicy, attempt: number): number {
    return retryPolicy.backoffMs * Math.pow(2, attempt);
  }

  /** Whether the workflow should abort on first task failure. */
  get failFast(): boolean {
    return this.workflowPolicy.failFast;
  }

  /** Workflow-level timeout in milliseconds. */
  get timeoutMs(): number {
    return this.workflowPolicy.timeoutMs;
  }
}
