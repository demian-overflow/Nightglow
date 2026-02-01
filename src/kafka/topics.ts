/**
 * Nightglow Kafka topic definitions.
 * All topics are prefixed with the configured topicPrefix.
 */

export const TOPICS = {
  /** Raw instrument measurements — high volume, partitioned by sessionId */
  MEASUREMENTS: "measurements",
  /** Alert-level signals from instruments */
  ALERTS: "alerts",
  /** Action lifecycle events (start/complete/fail) */
  ACTIONS: "actions",
  /** Task lifecycle events */
  TASKS: "tasks",
  /** Session lifecycle events */
  SESSIONS: "sessions",
  /** Detection signals — bot checks, fingerprint probes, honeypots */
  DETECTIONS: "detections",
  /** Behavioral anomaly events */
  ANOMALIES: "anomalies",
  /** Instrument management commands (enable/disable/reload) */
  INSTRUMENT_COMMANDS: "instrument-commands",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

export function resolveTopicName(prefix: string, topic: TopicName): string {
  return `${prefix}.${topic}`;
}

/** Map event types to their target topics */
export function eventTypeToTopic(
  eventType: string,
): TopicName {
  if (eventType.startsWith("instrument.measurement")) return TOPICS.MEASUREMENTS;
  if (eventType.startsWith("instrument.alert")) return TOPICS.ALERTS;
  if (eventType.startsWith("instrument.lifecycle")) return TOPICS.INSTRUMENT_COMMANDS;
  if (eventType.startsWith("action.")) return TOPICS.ACTIONS;
  if (eventType.startsWith("task.")) return TOPICS.TASKS;
  if (eventType.startsWith("session.")) return TOPICS.SESSIONS;
  if (eventType.startsWith("detection.")) return TOPICS.DETECTIONS;
  if (eventType.startsWith("behavioral.")) return TOPICS.ANOMALIES;
  return TOPICS.MEASUREMENTS;
}
