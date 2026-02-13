// Reconciliation state machine from SPEC.md:
//
//   [*] --> Pending
//   Pending --> Scheduled
//   Scheduled --> Running
//   Running --> Succeeded
//   Running --> Failed
//   Failed --> Retrying  (if retryPolicy.allows)
//   Retrying --> Running
//   Failed --> Escalated  (if retries exhausted)
//   Escalated --> [*]
//   Succeeded --> [*]

export type TaskState =
  | "Pending"
  | "Scheduled"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Retrying"
  | "Escalated";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "Succeeded",
  "Escalated",
]);

export interface TaskStatus {
  state: TaskState;
  retryCount: number;
  lastError?: string;
  updatedAt: number;
}

export function initialStatus(): TaskStatus {
  return {
    state: "Pending",
    retryCount: 0,
    updatedAt: Date.now(),
  };
}
