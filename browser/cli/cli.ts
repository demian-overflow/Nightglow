import { readFile } from "node:fs/promises";
import { parseWorkflow } from "../dsl/index.js";
import type { BrowserConfig } from "../config/index.js";
import { defaultConfig } from "../config/index.js";

export interface CliArgs {
  workflowFile: string;
  configOverrides?: Partial<BrowserConfig>;
}

export function parseArgs(argv: string[]): CliArgs {
  const file = argv[2];
  if (!file) {
    throw new Error("Usage: nightglow-browser <workflow.json>");
  }
  return { workflowFile: file };
}

export async function loadWorkflow(args: CliArgs) {
  const raw = await readFile(args.workflowFile, "utf-8");
  const data = JSON.parse(raw);
  return parseWorkflow(data);
}

export function resolveConfig(overrides?: Partial<BrowserConfig>): BrowserConfig {
  if (!overrides) return defaultConfig;
  return { ...defaultConfig, ...overrides };
}
