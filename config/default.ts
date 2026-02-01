import type { NightglowConfig } from "../src/types/index.js";

/**
 * Default Nightglow configuration.
 * All values can be overridden via environment variables or programmatic config.
 */
export const defaultConfig: NightglowConfig = {
  kafka: {
    brokers: (process.env.NIGHTGLOW_KAFKA_BROKERS ?? "localhost:9092").split(","),
    clientId: process.env.NIGHTGLOW_KAFKA_CLIENT_ID ?? "nightglow",
    topicPrefix: process.env.NIGHTGLOW_KAFKA_TOPIC_PREFIX ?? "nightglow",
    producer: {
      batchSize: parseInt(process.env.NIGHTGLOW_KAFKA_BATCH_SIZE ?? "50", 10),
      lingerMs: parseInt(process.env.NIGHTGLOW_KAFKA_LINGER_MS ?? "500", 10),
      compression: (process.env.NIGHTGLOW_KAFKA_COMPRESSION as any) ?? "gzip",
    },
    consumer: {
      groupId: process.env.NIGHTGLOW_KAFKA_GROUP_ID ?? "nightglow-commands",
    },
  },

  observability: {
    serviceName: process.env.NIGHTGLOW_SERVICE_NAME ?? "nightglow",
    traceEndpoint: process.env.NIGHTGLOW_OTLP_TRACES_ENDPOINT ?? "http://localhost:4318/v1/traces",
    metricsEndpoint: process.env.NIGHTGLOW_OTLP_METRICS_ENDPOINT ?? "http://localhost:4318/v1/metrics",
    traceSampleRate: parseFloat(process.env.NIGHTGLOW_TRACE_SAMPLE_RATE ?? "1.0"),
    metricsInterval: parseInt(process.env.NIGHTGLOW_METRICS_INTERVAL_MS ?? "15000", 10),
  },

  instruments: {
    autoEnable: (process.env.NIGHTGLOW_AUTO_ENABLE_INSTRUMENTS ?? "true") === "true",
    maxContinuous: parseInt(process.env.NIGHTGLOW_MAX_CONTINUOUS ?? "5", 10),
  },

  logLevel: (process.env.NIGHTGLOW_LOG_LEVEL as any) ?? "info",
};
