import type { BrowserWorkflow, Task } from "../../dsl/types.js";

export interface ScheduledBatch {
  tasks: Task[];
}

/**
 * Resolves task dependency order and produces batches of tasks
 * that can run concurrently (all dependencies satisfied).
 */
export class Scheduler {
  /**
   * Topologically sort workflow tasks and yield execution batches.
   * Tasks within a batch have no inter-dependencies and may run in parallel.
   */
  plan(workflow: BrowserWorkflow): ScheduledBatch[] {
    const taskMap = new Map(workflow.tasks.map((t) => [t.name, t]));
    const completed = new Set<string>();
    const batches: ScheduledBatch[] = [];
    let remaining = new Set(taskMap.keys());

    while (remaining.size > 0) {
      const ready: Task[] = [];

      for (const name of remaining) {
        const task = taskMap.get(name)!;
        const depsMet = task.dependsOn.every((d) => completed.has(d));
        if (depsMet) ready.push(task);
      }

      if (ready.length === 0) {
        const cycle = [...remaining].join(", ");
        throw new Error(`Dependency cycle detected among: ${cycle}`);
      }

      batches.push({ tasks: ready });
      for (const t of ready) {
        completed.add(t.name);
        remaining.delete(t.name);
      }
    }

    return batches;
  }
}
