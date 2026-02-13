import type { Step, ExtractStep } from "../../dsl/types.js";

export interface ExecutionContext {
  page: unknown;
  sessionId: string;
}

export interface StepResult {
  step: Step;
  success: boolean;
  durationMs: number;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Executes individual DSL steps against a browser page via CDP/puppeteer.
 */
export class BrowserExecutor {
  async execute(step: Step, ctx: ExecutionContext): Promise<StepResult> {
    const start = Date.now();
    try {
      const data = await this.dispatch(step, ctx);
      return {
        step,
        success: true,
        durationMs: Date.now() - start,
        data,
      };
    } catch (err) {
      return {
        step,
        success: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async dispatch(
    step: Step,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown> | undefined> {
    const page = ctx.page as any;

    switch (step.type) {
      case "navigate":
        await page.goto(step.url);
        return undefined;

      case "waitFor":
        await page.waitForSelector(step.selector, {
          timeout: step.timeoutMs,
        });
        return undefined;

      case "click":
        await page.click(step.selector);
        return undefined;

      case "extract":
        return this.extract(step, page);
    }
  }

  private async extract(
    step: ExtractStep,
    page: any,
  ): Promise<Record<string, unknown>> {
    const el = await page.$(step.selector);
    if (!el) throw new Error(`Element not found: ${step.selector}`);

    const result: Record<string, unknown> = {};
    for (const field of step.schema.fields) {
      result[field.name] = await el.evaluate(
        (node: any, attr: string) => node.getAttribute(attr) ?? node.textContent,
        field.name,
      );
    }
    return result;
  }
}
