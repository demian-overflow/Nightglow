import { Kafka, Consumer, type EachMessagePayload } from "kafkajs";
import type { KafkaConfig } from "../types/index.js";
import { resolveTopicName, TOPICS } from "./topics.js";
import pino from "pino";

export type CommandHandler = (command: InstrumentCommand) => Promise<void>;

export interface InstrumentCommand {
  action: "enable" | "disable" | "reload" | "update_config";
  instrumentId: string;
  payload?: Record<string, unknown>;
}

/**
 * Kafka consumer for instrument management commands.
 * Listens on the instrument-commands topic and dispatches to registered handlers.
 */
export class CommandConsumer {
  private kafka: Kafka;
  private consumer: Consumer;
  private logger: pino.Logger;
  private config: KafkaConfig;
  private handlers: CommandHandler[] = [];
  private running = false;

  constructor(config: KafkaConfig, logger?: pino.Logger) {
    this.config = config;
    this.logger = (logger ?? pino({ level: "info" })).child({ component: "nightglow.consumer" });

    this.kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      ssl: config.ssl ?? false,
      ...(config.sasl ? { sasl: config.sasl } : {}),
    });

    this.consumer = this.kafka.consumer({
      groupId: config.consumer?.groupId ?? `${config.clientId}-commands`,
    });
  }

  onCommand(handler: CommandHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.running) return;

    await this.consumer.connect();

    const commandTopic = resolveTopicName(
      this.config.topicPrefix,
      TOPICS.INSTRUMENT_COMMANDS,
    );

    await this.consumer.subscribe({ topic: commandTopic, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      },
    });

    this.running = true;
    this.logger.info({ topic: commandTopic }, "Command consumer started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.consumer.disconnect();
    this.running = false;
    this.logger.info("Command consumer stopped");
  }

  private async handleMessage({ message }: EachMessagePayload): Promise<void> {
    if (!message.value) return;

    try {
      const command: InstrumentCommand = JSON.parse(message.value.toString());

      this.logger.debug(
        { action: command.action, instrumentId: command.instrumentId },
        "Received instrument command",
      );

      for (const handler of this.handlers) {
        await handler(command);
      }
    } catch (err) {
      this.logger.error({ err }, "Failed to process instrument command");
    }
  }
}
