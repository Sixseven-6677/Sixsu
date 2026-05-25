import { Context }         from "../context/Context";
import { CommandRegistry } from "./CommandRegistry";
import { ICommand }        from "./types/ICommand";
import {
  IMiddleware,
  MiddlewareFn,
  toMiddlewareFn,
} from "../middleware/types/IMiddleware";
import { LoggerManager }  from "../logger/LoggerManager";

const log = LoggerManager.getLogger("CommandPipeline");

export type NotFoundHandler = (ctx: Context) => Promise<void>;

interface PipelineStep {
  readonly name: string;
  readonly fn:   MiddlewareFn;
}

export class CommandPipeline {
  private readonly registry: CommandRegistry;
  private readonly prefix:   string;
  /** Ordered list of named middleware steps. */
  private readonly steps:    PipelineStep[] = [];
  private notFoundHandler?:  NotFoundHandler;

  constructor(registry: CommandRegistry, prefix = "") {
    this.registry = registry;
    this.prefix   = prefix;
  }

  /**
   * Add a middleware step.
   * Name resolution order:
   *  1. IMiddleware.name (if object is passed)
   *  2. Function's own .name (e.g. named arrow set via computed-property trick)
   *  3. Positional label  "step-N"
   */
  use(middleware: MiddlewareFn | IMiddleware): this {
    const isObj = typeof middleware !== "function";
    const fn    = isObj ? toMiddlewareFn(middleware) : middleware;
    const name  = isObj
      ? middleware.name
      : (middleware.name || `step-${this.steps.length + 1}`);
    this.steps.push({ name, fn });
    return this;
  }

  onNotFound(handler: NotFoundHandler): this {
    this.notFoundHandler = handler;
    return this;
  }

  // ─── Main entry point ────────────────────────────────────────────────────

  async run(ctx: Context): Promise<void> {
    // Short correlation ID for log lines belonging to the same message.
    const traceId = ctx.message.id.replace(/[^a-z0-9]/gi, "").slice(0, 10);

    // ── Step 1 · Log incoming message ──────────────────────────────────────
    log.debug(`[${traceId}] ► Incoming message`, {
      userId:   ctx.user.id,
      role:     ctx.user.role,
      text:     (ctx.message.text ?? "").slice(0, 80),
      isPostback: ctx.message.isPostback,
      attachments: ctx.message.attachments.length,
    });

    // ── Step 2 · Prefix check ──────────────────────────────────────────────
    let rawName = ctx.commandName;

    if (this.prefix) {
      if (!rawName.startsWith(this.prefix)) {
        log.debug(
          `[${traceId}] ✗ Prefix "${this.prefix}" not matched — not a command.`,
          { rawName }
        );
        return;
      }
      rawName = rawName.slice(this.prefix.length);
      log.debug(`[${traceId}] ✓ Prefix matched — name: "${rawName}"`);
    }

    if (!rawName) {
      log.debug(`[${traceId}] ✗ Empty command name after prefix strip.`);
      return;
    }

    // ── Step 3 · Registry lookup ───────────────────────────────────────────
    const command = this.registry.resolve(rawName);
    if (!command) {
      log.debug(
        `[${traceId}] ✗ "${rawName}" not found in registry ` +
        `(${this.registry.size()} command(s) registered) — notFoundHandler triggered.`
      );
      await this.notFoundHandler?.(ctx);
      return;
    }

    log.debug(
      `[${traceId}] ✓ Resolved "${rawName}" → "${command.name}"` +
      ` [${command.category ?? "general"}]` +
      (command.adminOnly ? " 🔒 adminOnly" : "")
    );

    // ── Step 4 · Arg count validation ──────────────────────────────────────
    if (command.minArgs !== undefined && ctx.args.length < command.minArgs) {
      log.debug(
        `[${traceId}] ✗ minArgs failed: got ${ctx.args.length}, ` +
        `need ≥${command.minArgs} — sending usage hint.`
      );
      const usage = command.usage ?? `${this.prefix}${command.name}`;
      await ctx.reply(
        `❌ هذا الأمر يتطلب ${command.minArgs} مُدخل/مُدخلات على الأقل.\n` +
        `📌 الاستخدام: ${usage}`
      );
      return;
    }

    if (command.maxArgs !== undefined && ctx.args.length > command.maxArgs) {
      log.debug(
        `[${traceId}] ✗ maxArgs failed: got ${ctx.args.length}, ` +
        `max is ${command.maxArgs} — sending usage hint.`
      );
      const usage = command.usage ?? `${this.prefix}${command.name}`;
      await ctx.reply(
        `❌ هذا الأمر يقبل ${command.maxArgs} مُدخل/مُدخلات كحدٍّ أقصى.\n` +
        `📌 الاستخدام: ${usage}`
      );
      return;
    }

    // ── Step 5 · Run middleware pipeline step-by-step ──────────────────────
    const stepNames = this.steps.map((s) => s.name).join(" → ");
    log.debug(
      `[${traceId}] ► Pipeline (${this.steps.length} step(s)): ` +
      `[${stepNames}] → execute`,
      { command: command.name, args: ctx.args }
    );

    const pipelineStart = Date.now();
    await this.runStep(ctx, command, 0, traceId, pipelineStart);
  }

  // ─── Recursive step dispatcher ───────────────────────────────────────────

  private async runStep(
    ctx:           Context,
    command:       ICommand,
    index:         number,
    traceId:       string,
    pipelineStart: number
  ): Promise<void> {
    // All middleware passed — execute the command
    if (index >= this.steps.length) {
      const pipelineMs = Date.now() - pipelineStart;
      log.debug(
        `[${traceId}] ✓ All ${this.steps.length} middleware(s) passed ` +
        `(${pipelineMs}ms) → executing "${command.name}"`
      );

      const execStart = Date.now();
      try {
        await command.execute(ctx);
        log.debug(
          `[${traceId}] ✓ "${command.name}" executed successfully ` +
          `| ${Date.now() - execStart}ms`
        );
      } catch (err) {
        const execMs = Date.now() - execStart;
        const msg    = err instanceof Error ? err.message : String(err);
        log.error(
          `[${traceId}] ✗ "${command.name}" threw after ${execMs}ms: ${msg}`,
          err instanceof Error ? err : undefined
        );
        await ctx
          .reply("⚠️ حدث خطأ أثناء تنفيذ الأمر. يُرجى المحاولة مجدداً.")
          .catch(() => {});
      }
      return;
    }

    const step      = this.steps[index]!;
    const stepStart = Date.now();
    let   nextCalled = false;

    log.debug(
      `[${traceId}] → [${index + 1}/${this.steps.length}] middleware:"${step.name}"`,
      { userId: ctx.user.id, command: command.name }
    );

    try {
      await step.fn(ctx, command, async () => {
        nextCalled = true;
        await this.runStep(ctx, command, index + 1, traceId, pipelineStart);
      });
    } catch (err) {
      const stepMs = Date.now() - stepStart;
      const msg    = err instanceof Error ? err.message : String(err);
      log.error(
        `[${traceId}] ✗ middleware:"${step.name}" THREW ERROR ` +
        `after ${stepMs}ms: ${msg}`
      );
      throw err;
    }

    const stepMs = Date.now() - stepStart;
    if (nextCalled) {
      log.debug(`[${traceId}] ✓ "${step.name}" passed | ${stepMs}ms`);
    } else {
      // This is the critical line — tells you EXACTLY where the chain stopped.
      log.debug(
        `[${traceId}] ✗ "${step.name}" STOPPED pipeline | ${stepMs}ms` +
        ` — no further steps will run`
      );
    }
  }
}
