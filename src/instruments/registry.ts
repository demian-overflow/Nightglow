import type { Instrument, InstrumentPhase } from "../types/index.js";
import pino from "pino";

/**
 * Central registry for all active instruments.
 * Supports lookup by ID, phase, action type, and kind.
 */
export class InstrumentRegistry {
  private instruments = new Map<string, Instrument>();
  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger = (logger ?? pino({ level: "info" })).child({
      component: "nightglow.registry",
    });
  }

  register(instrument: Instrument): void {
    this.instruments.set(instrument.id, instrument);
    this.logger.info(
      { id: instrument.id, name: instrument.name, kind: instrument.kind },
      "Instrument registered",
    );
  }

  unregister(id: string): boolean {
    const existed = this.instruments.delete(id);
    if (existed) {
      this.logger.info({ id }, "Instrument unregistered");
    }
    return existed;
  }

  get(id: string): Instrument | undefined {
    return this.instruments.get(id);
  }

  enable(id: string): boolean {
    const instrument = this.instruments.get(id);
    if (!instrument) return false;
    instrument.enabled = true;
    this.logger.debug({ id }, "Instrument enabled");
    return true;
  }

  disable(id: string): boolean {
    const instrument = this.instruments.get(id);
    if (!instrument) return false;
    instrument.enabled = false;
    this.logger.debug({ id }, "Instrument disabled");
    return true;
  }

  /**
   * Get all enabled instruments that should fire for a given phase and action type.
   * Returns instruments sorted by priority (lower first).
   */
  getForPhase(phase: InstrumentPhase, actionType?: string): Instrument[] {
    const results: Instrument[] = [];

    for (const instrument of this.instruments.values()) {
      if (!instrument.enabled) continue;
      if (instrument.phase !== phase && instrument.phase !== "continuous") continue;

      // If instrument has action filters, check if current action matches
      if (
        instrument.actionFilter.length > 0 &&
        actionType &&
        !instrument.actionFilter.includes(actionType)
      ) {
        continue;
      }

      results.push(instrument);
    }

    return results.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get all registered instruments.
   */
  getAll(): Instrument[] {
    return Array.from(this.instruments.values());
  }

  /**
   * Get count of enabled instruments.
   */
  get activeCount(): number {
    let count = 0;
    for (const i of this.instruments.values()) {
      if (i.enabled) count++;
    }
    return count;
  }

  get totalCount(): number {
    return this.instruments.size;
  }

  clear(): void {
    this.instruments.clear();
  }
}
