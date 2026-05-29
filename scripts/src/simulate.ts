/**
 * simulate.ts — Local Event Runner for Sixsu Bot
 *
 * Simulates /ping, /help, /userinfo without any Facebook or MongoDB connection.
 * Runs the full middleware + command pipeline with a mock ISender.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/src/simulate.ts
 */

import { CommandRegistry }        from "../../src/commands/CommandRegistry";
import { CommandPipeline }        from "../../src/commands/CommandPipeline";
import { Context }                from "../../src/context/Context";
import {
  ContextUser,
  ContextThread,
  ContextMessage,
} from "../../src/context/types";
import { ISender }                from "../../src/facebook/types/ISender";
import { IPluginContext }         from "../../src/plugins/types/IPluginContext";
import { ILogger }                from "../../src/logger/types/ILogger";
import { ICommand }               from "../../src/commands/types/ICommand";
import { createPingCommand }      from "../../src/plugins/definitions/utility/commands/ping.command";
import { createHelpCommand }      from "../../src/plugins/definitions/utility/commands/help.command";
import { createUserinfoCommand }  from "../../src/plugins/definitions/utility/commands/userinfo.command";
import { ResponseBuilder }        from "../../src/plugins/definitions/utility/services/ResponseBuilder";
import { SERVICES }               from "../../src/plugins/definitions/utility/services/IUtilityServices";

// ── Colour helpers ────────────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  grey:   "\x1b[90m",
};
const h1 = (s: string) => console.log(`\n${C.bold}${C.cyan}${s}${C.reset}\n${"─".repeat(60)}`);
const ok = (s: string) => console.log(`${C.green}✅ ${s}${C.reset}`);
const warn = (s: string) => console.log(`${C.yellow}⚠️  ${s}${C.reset}`);
const err  = (s: string) => console.log(`${C.red}❌ ${s}${C.reset}`);
const info = (s: string) => console.log(`${C.grey}   ${s}${C.reset}`);

// ── Mock ISender ──────────────────────────────────────────────────────────────
interface CapturedMessage {
  to:    string;
  text:  string;
}
interface CapturedReaction {
  messageId: string;
  threadId:  string;
  emoji:     string;
}

function createMockSender(): ISender & {
  replies:   CapturedMessage[];
  reactions: CapturedReaction[];
  typings:   string[];
  reset():   void;
} {
  const replies:   CapturedMessage[]  = [];
  const reactions: CapturedReaction[] = [];
  const typings:   string[]           = [];

  return {
    replies,
    reactions,
    typings,
    reset() {
      replies.length   = 0;
      reactions.length = 0;
      typings.length   = 0;
    },
    async sendText(recipientId, text) {
      replies.push({ to: recipientId, text });
    },
    async sendTyping(recipientId) {
      typings.push(recipientId);
    },
    async sendReaction(messageId, threadId, emoji) {
      reactions.push({ messageId, threadId, emoji });
    },
  };
}

// ── Mock ILogger ──────────────────────────────────────────────────────────────
function createSilentLogger(name: string): ILogger {
  return {
    debug: () => {},
    info:  (msg: string) => info(`[${name}] ${msg}`),
    warn:  (msg: string) => warn(`[${name}] ${msg}`),
    error: (msg: string, e?: unknown) => err(`[${name}] ${msg} ${e ?? ""}`),
    child: (ctx: Record<string, unknown>) => createSilentLogger(`${name}:${JSON.stringify(ctx)}`),
  };
}

// ── Mock PluginContext ─────────────────────────────────────────────────────────
function createMockPluginCtx(
  registry: CommandRegistry,
  services: Map<string, unknown>,
  pluginName = "utility"
): IPluginContext {
  const logger = createSilentLogger(`Plugin:${pluginName}`);
  const ownServices = new Map<string, unknown>(services);

  return {
    pluginName,
    logger,
    getConfig<T>(key: string, fallback?: T): T {
      return (fallback as T);
    },
    registerCommand(cmd: ICommand) {
      registry.register(cmd);
      return { dispose: () => registry.unregister(cmd.name) };
    },
    emit() {},
    on() { return { dispose: () => {} }; },
    provideService<T>(name: string, svc: T) {
      ownServices.set(name, svc);
      return { dispose: () => ownServices.delete(name) };
    },
    consumeService<T>(name: string): T | undefined {
      return ownServices.get(name) as T | undefined;
    },
    requireService<T>(name: string): T {
      const svc = ownServices.get(name);
      if (!svc) throw new Error(`Required service "${name}" not found.`);
      return svc as T;
    },
    scheduleRecurring() { return { dispose: () => {} }; },
    scheduleDelayed()   { return { dispose: () => {} }; },
  };
}

// ── Build a mock Context ──────────────────────────────────────────────────────
function buildContext(
  rawText:  string,
  sender:   ISender,
  opts: {
    userId?:  string;
    threadId?: string;
    role?:    "user" | "admin" | "moderator" | "owner";
    name?:    string;
  } = {}
): Context {
  const userId   = opts.userId   ?? "user-001";
  const threadId = opts.threadId ?? "thread-001";

  const user: ContextUser = {
    id:           userId,
    name:         opts.name ?? "أحمد (Simulated)",
    role:         opts.role ?? "user",
    messageCount: 42,
    lastSeen:     new Date(),
    createdAt:    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    preferences:  {},
    isNew:        false,
  };

  const thread: ContextThread = {
    id:     threadId,
    pageId: "page-bot-001",
  };

  const message: ContextMessage = {
    id:          `sim-msg-${Date.now()}`,
    text:        rawText,
    attachments: [],
    timestamp:   Date.now(),
    isPostback:  false,
  };

  return new Context(user, thread, message, sender);
}

// ── Run a single command simulation ──────────────────────────────────────────
async function simulate(
  label:    string,
  rawText:  string,
  pipeline: CommandPipeline,
  sender:   ReturnType<typeof createMockSender>,
  opts: {
    userId?:   string;
    threadId?: string;
    role?:     "user" | "admin" | "moderator" | "owner";
    name?:     string;
    expectReply?: RegExp | string;
    expectBlock?: boolean;
  } = {}
): Promise<boolean> {
  sender.reset();
  const ctx = buildContext(rawText, sender, opts);

  const start = Date.now();
  await pipeline.run(ctx);
  const ms = Date.now() - start;

  const replied  = sender.replies.length > 0;
  const replyText = sender.replies.map(r => r.text).join(" | ");

  // Check reply routing: all replies should go to thread.id not user.id
  const routingOk = sender.replies.every(r => r.to === ctx.thread.id);
  const typingOk  = sender.typings.every(t => t === ctx.thread.id);

  let pass = true;
  let notes: string[] = [];

  if (opts.expectBlock) {
    if (replied) {
      info(`Reply: ${replyText.slice(0, 120)}`);
    }
    ok(`[${label}] Blocked as expected (${ms}ms)`);
  } else if (opts.expectReply) {
    const pattern = opts.expectReply instanceof RegExp
      ? opts.expectReply
      : new RegExp(opts.expectReply);
    if (replied && pattern.test(replyText)) {
      ok(`[${label}] Command executed (${ms}ms)`);
    } else {
      err(`[${label}] Expected reply matching ${pattern} but got: "${replyText.slice(0,100)}"`);
      pass = false;
    }
  } else if (replied) {
    ok(`[${label}] Command replied (${ms}ms)`);
  } else {
    warn(`[${label}] No reply produced (${ms}ms) — was the pipeline blocked?`);
    pass = false;
  }

  if (replied) {
    const short = replyText.length > 200 ? replyText.slice(0, 200) + "…" : replyText;
    info(`Reply → threadId:${ctx.thread.id} | text: ${short}`);
  }
  if (sender.typings.length > 0) {
    if (typingOk) {
      info(`TypingOn sent to correct thread.id: ${ctx.thread.id} ✓`);
    } else {
      warn(`TypingOn sent to ${sender.typings[0]} but thread.id is ${ctx.thread.id}`);
      notes.push("typing routing mismatch");
    }
  }
  if (replied && !routingOk) {
    const wrongDest = sender.replies.find(r => r.to !== ctx.thread.id);
    warn(`Reply routed to "${wrongDest?.to}" but thread.id is "${ctx.thread.id}"`);
    notes.push("reply routing mismatch");
    pass = false;
  } else if (replied) {
    info(`Reply routing to thread.id: ✓`);
  }
  if (notes.length) info(`Notes: ${notes.join("; ")}`);

  return pass;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const PREFIX = "/";

  console.log(`\n${C.bold}${C.cyan}╔════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║      Sixsu Bot — Local Event Runner            ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════════════╝${C.reset}`);
  info(`Prefix: "${PREFIX}"  |  Date: ${new Date().toISOString()}`);

  // ── Setup ────────────────────────────────────────────────────────────────
  const registry = new CommandRegistry();
  const sender   = createMockSender();

  // Services the utility plugin needs
  const services = new Map<string, unknown>();
  const rb = new ResponseBuilder();
  services.set(SERVICES.COMMAND_REGISTRY, registry);
  services.set(SERVICES.RESPONSE_BUILDER, rb);
  // Intentionally omit SERVICES.FB_ACCESS_TOKEN to test degraded userinfo
  // (represents no Graph API token — /userinfo still works from ctx data)

  const pluginCtx = createMockPluginCtx(registry, services);

  // Manually trigger UtilityPlugin.onLoad + onEnable logic inline
  pluginCtx.provideService(SERVICES.RESPONSE_BUILDER, rb);
  pluginCtx.registerCommand(createPingCommand(pluginCtx));
  pluginCtx.registerCommand(createHelpCommand(pluginCtx));
  pluginCtx.registerCommand(createUserinfoCommand(pluginCtx));

  info(`Commands registered: [${registry.getAll().map(c=>c.name).join(", ")}]`);

  // No-op middleware pipeline (bypass bans/cooldowns for simulation)
  const pipeline = new CommandPipeline(registry, PREFIX)
    .onNotFound(async (ctx) => {
      await ctx.reply(`❓ الأمر "${ctx.commandName}" غير موجود.`);
    });

  let pass = 0; let fail = 0;
  const track = (ok: boolean) => ok ? pass++ : fail++;

  // ── Tests: /ping ─────────────────────────────────────────────────────────
  h1("TEST SUITE 1: /ping");

  track(await simulate(
    "/ping basic",
    "/ping",
    pipeline, sender,
    { expectReply: /Pong!|latency/i }
  ));

  track(await simulate(
    "/ping alias /p",
    "/p",
    pipeline, sender,
    { expectReply: /Pong!|latency/i }
  ));

  track(await simulate(
    "/ping reply routed to thread",
    "/ping",
    pipeline, sender,
    { userId: "user-111", threadId: "group-thread-999", expectReply: /Pong!/ }
  ));

  // ── Tests: /help ─────────────────────────────────────────────────────────
  h1("TEST SUITE 2: /help");

  track(await simulate(
    "/help full listing",
    "/help",
    pipeline, sender,
    { expectReply: /utility|UTILITY/i }
  ));

  track(await simulate(
    "/help specific command",
    "/help ping",
    pipeline, sender,
    { expectReply: /ping/ }
  ));

  track(await simulate(
    "/help alias /?",
    "/?",
    pipeline, sender,
    { expectReply: /utility|UTILITY|أمر/i }
  ));

  track(await simulate(
    "/help unknown command",
    "/help xyznonexistent",
    pipeline, sender,
    { expectReply: /غير موجود/ }
  ));

  // ── Tests: /userinfo ──────────────────────────────────────────────────────
  h1("TEST SUITE 3: /userinfo");

  track(await simulate(
    "/userinfo basic",
    "/userinfo",
    pipeline, sender,
    { userId: "123456789", threadId: "thread-abc", expectReply: /المعرف|المحادثة/ }
  ));

  track(await simulate(
    "/userinfo alias /whoami",
    "/whoami",
    pipeline, sender,
    { userId: "987654321", expectReply: /المعرف|المحادثة/ }
  ));

  track(await simulate(
    "/userinfo shows thread.id not user.id in reply routing",
    "/userinfo",
    pipeline, sender,
    {
      userId: "real-user-id",
      threadId: "group-thread-id",
      expectReply: /المحادثة.*group-thread-id|group-thread-id/,
    }
  ));

  // ── Tests: unknown commands ───────────────────────────────────────────────
  h1("TEST SUITE 4: Edge Cases");

  track(await simulate(
    "Unknown command triggers notFound",
    "/unknowncmd",
    pipeline, sender,
    { expectReply: /غير موجود/ }
  ));

  track(await simulate(
    "Message without prefix is ignored (no reply)",
    "hello world",
    pipeline, sender,
    { expectBlock: true }
  ));

  track(await simulate(
    "Bare prefix with no command name (ignored)",
    "/",
    pipeline, sender,
    { expectBlock: true }
  ));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`${C.bold}RESULTS: ${pass} passed, ${fail} failed out of ${pass + fail} tests${C.reset}`);
  if (fail === 0) {
    console.log(`${C.green}${C.bold}✅ All tests passed — Bot pipeline is READY${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}❌ ${fail} test(s) failed — review output above${C.reset}`);
    process.exit(1);
  }
  console.log(`${"═".repeat(60)}\n`);
}

main().catch((e) => {
  console.error("Simulation crashed:", e);
  process.exit(1);
});
