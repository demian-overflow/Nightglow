import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { ObservabilityConfig } from "../types/index.js";

let meterProvider: MeterProvider | null = null;

/**
 * Initialize the OpenTelemetry meter provider.
 */
export function initMetrics(config: ObservabilityConfig): NightglowMetrics {
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...Object.fromEntries(
      Object.entries(config.resourceAttributes ?? {}).map(([k, v]) => [k, v]),
    ),
  });

  const readers = [];

  if (config.metricsEndpoint) {
    const exporter = new OTLPMetricExporter({
      url: config.metricsEndpoint,
    });
    readers.push(
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: config.metricsInterval ?? 15000,
      }),
    );
  }

  meterProvider = new MeterProvider({ resource, readers });

  return createMetrics();
}

export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
  }
}

/**
 * Nightglow metrics — counters, histograms, gauges.
 */
export interface NightglowMetrics {
  /** Count of tasks executed */
  taskCount: (attrs: { taskName: string; status: string }) => void;
  /** Action execution duration histogram */
  actionDuration: (ms: number, attrs: { actionType: string; taskName: string }) => void;
  /** Idle period duration histogram */
  idleDuration: (ms: number, attrs: { taskName: string }) => void;
  /** Instrument measurement count */
  instrumentMeasurements: (attrs: { instrumentKind: string; severity: string }) => void;
  /** Active instruments gauge */
  activeInstruments: (count: number) => void;
  /** Kafka events emitted */
  kafkaEventsEmitted: (attrs: { topic: string }) => void;
  /** Detection signals */
  detectionSignals: (attrs: { signal: string; severity: string }) => void;
}

function createMetrics(): NightglowMetrics {
  const meter = meterProvider!.getMeter("nightglow");

  const taskCounter = meter.createCounter("nightglow.tasks.total", {
    description: "Total tasks executed",
  });

  const actionHist = meter.createHistogram("nightglow.actions.duration_ms", {
    description: "Action execution duration in milliseconds",
    unit: "ms",
  });

  const idleHist = meter.createHistogram("nightglow.idle.duration_ms", {
    description: "Idle period duration in milliseconds",
    unit: "ms",
  });

  const instrumentCounter = meter.createCounter(
    "nightglow.instruments.measurements_total",
    { description: "Total instrument measurements taken" },
  );

  const activeGauge = meter.createUpDownCounter(
    "nightglow.instruments.active",
    { description: "Currently active instruments" },
  );

  const kafkaCounter = meter.createCounter("nightglow.kafka.events_total", {
    description: "Total events emitted to Kafka",
  });

  const detectionCounter = meter.createCounter(
    "nightglow.detections.signals_total",
    { description: "Total detection signals observed" },
  );

  return {
    taskCount: (attrs) => taskCounter.add(1, attrs),
    actionDuration: (ms, attrs) => actionHist.record(ms, attrs),
    idleDuration: (ms, attrs) => idleHist.record(ms, attrs),
    instrumentMeasurements: (attrs) => instrumentCounter.add(1, attrs),
    activeInstruments: (count) => activeGauge.add(count),
    kafkaEventsEmitted: (attrs) => kafkaCounter.add(1, attrs),
    detectionSignals: (attrs) => detectionCounter.add(1, attrs),
  };
}
