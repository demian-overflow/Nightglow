import { Kafka, Producer, CompressionTypes, type Message } from "kafkajs";
import type { KafkaConfig, NightglowEvent } from "../types/index.js";
import { resolveTopicName, eventTypeToTopic } from "./topics.js";
import pino from "pino";

interface BufferedMessage {
  topic: string;
  message: Message;
}

/**
 * Nightglow Kafka producer with internal buffering and batch flush.
 * Events are buffered and flushed either when the batch size is reached
 * or the linger timer fires — whichever comes first.
 */
export class EventProducer {
  private kafka: Kafka;
  private producer: Producer;
  private logger: pino.Logger;
  private config: KafkaConfig;
  private buffer: BufferedMessage[] = [];
  private lingerTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  private readonly batchSize: number;
  private readonly lingerMs: number;
  private readonly compression: CompressionTypes;

  constructor(config: KafkaConfig, logger?: pino.Logger) {
    this.config = config;
    this.logger = (logger ?? pino({ level: "info" })).child({ component: "nightglow.producer" });

    this.batchSize = config.producer?.batchSize ?? 50;
    this.lingerMs = config.producer?.lingerMs ?? 500;
    this.compression = this.resolveCompression(config.producer?.compression);

    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      ssl: config.ssl ?? false,
      ...(config.sasl ? { sasl: config.sasl } : {}),
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
    this.startLingerTimer();
    this.logger.info("Kafka producer connected");
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.stopLingerTimer();
    await this.flush();
    await this.producer.disconnect();
    this.connected = false;
    this.logger.info("Kafka producer disconnected");
  }

  /**
   * Emit a Nightglow event. Buffers internally; call flush() to force.
   */
  emit(event: NightglowEvent): void {
    const topicName = eventTypeToTopic(event.type);
    const fullTopic = resolveTopicName(this.config.topicPrefix, topicName);

    this.buffer.push({
      topic: fullTopic,
      message: {
        key: event.sessionId,
        value: JSON.stringify(event),
        headers: {
          "event-type": event.type,
          "source": event.source,
          "trace-id": event.traceContext?.traceId ?? "",
          "span-id": event.traceContext?.spanId ?? "",
        },
        timestamp: String(event.timestamp),
      },
    });

    if (this.buffer.length >= this.batchSize) {
      this.flush().catch((err) =>
        this.logger.error({ err }, "Flush failed after batch threshold"),
      );
    }
  }

  /**
   * Flush all buffered messages to Kafka.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (!this.connected) {
      this.logger.warn("Cannot flush — producer not connected");
      return;
    }

    const messages = this.buffer.splice(0);

    // Group by topic for efficient batch send
    const byTopic = new Map<string, Message[]>();
    for (const msg of messages) {
      const existing = byTopic.get(msg.topic);
      if (existing) {
        existing.push(msg.message);
      } else {
        byTopic.set(msg.topic, [msg.message]);
      }
    }

    const topicMessages = Array.from(byTopic.entries()).map(
      ([topic, msgs]) => ({ topic, messages: msgs }),
    );

    try {
      await this.producer.sendBatch({
        topicMessages,
        compression: this.compression,
      });
      this.logger.debug(
        { count: messages.length, topics: topicMessages.length },
        "Flushed events to Kafka",
      );
    } catch (err) {
      // Put messages back at the front of the buffer for retry
      this.buffer.unshift(...messages);
      this.logger.error({ err, count: messages.length }, "Failed to send batch to Kafka");
      throw err;
    }
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  private startLingerTimer(): void {
    this.lingerTimer = setInterval(() => {
      this.flush().catch((err) =>
        this.logger.error({ err }, "Linger flush failed"),
      );
    }, this.lingerMs);
  }

  private stopLingerTimer(): void {
    if (this.lingerTimer) {
      clearInterval(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  private resolveCompression(codec?: string): CompressionTypes {
    switch (codec) {
      case "gzip": return CompressionTypes.GZIP;
      case "snappy": return CompressionTypes.Snappy;
      case "lz4": return CompressionTypes.LZ4;
      default: return CompressionTypes.None;
    }
  }
}
