import { Context }          from "../context/Context";
import { CommandPipeline }  from "../commands/CommandPipeline";
import { CommandRegistry }  from "../commands/CommandRegistry";
import { TaskScheduler }    from "../scheduler";
import { ReconnectManager } from "../facebook/reconnect/ReconnectManager";
import { BanStore }         from "../middleware/built-in/banned.middleware";
import type { IUserService } from "../users/types/IUserService";
import { LoggerManager }    from "../logger/LoggerManager";

const log = LoggerManager.getLogger("MessageHandler");

// ── Singleton references (wired by bootstrap) ─────────────────────────────

let pipeline:         CommandPipeline  | undefined;
let registry:         CommandRegistry  | undefined;
let scheduler:        TaskScheduler    | undefined;
let reconnectManager: ReconnectManager | undefined;
let banStore:         BanStore         | undefined;
let userService:      IUserService     | undefined;

export function setCommandPipeline(p: CommandPipeline):   void { pipeline         = p; }
export function setCommandRegistry(r: CommandRegistry):   void { registry         = r; }
export function setTaskScheduler(s: TaskScheduler):       void { scheduler        = s; }
export function setReconnectManager(r: ReconnectManager): void { reconnectManager = r; }
export function setBanStore(b: BanStore):                 void { banStore         = b; }
export function setUserService(s: IUserService):          void { userService      = s; }

export function getCommandPipeline():  CommandPipeline  | undefined { return pipeline;         }
export function getCommandRegistry():  CommandRegistry  | undefined { return registry;         }
export function getTaskScheduler():    TaskScheduler    | undefined { return scheduler;        }
export function getReconnectManager(): ReconnectManager | undefined { return reconnectManager; }
export function getBanStore():         BanStore         | undefined { return banStore;         }
export function getUserService():      IUserService     | undefined { return userService;      }

// ── Entry point ───────────────────────────────────────────────────────────

export async function handleMessage(ctx: Context): Promise<void> {
  // ── [A] Determine message type and log the routing decision ───────────
  const msgType = ctx.message.isPostback
    ? "postback"
    : ctx.message.attachments.length > 0
      ? "attachment"
      : ctx.message.text
        ? "text"
        : "empty";

  log.debug("Routing message.", {
    userId:  ctx.user.id,
    msgType,
    text:    (ctx.message.text ?? "").slice(0, 80),
    attachmentCount: ctx.message.attachments.length,
    postbackPayload: ctx.message.postbackPayload?.slice(0, 80),
  });

  // ── [B] Route to the appropriate handler ──────────────────────────────
  if (ctx.message.isPostback) {
    log.debug(`Dispatching to handlePostback | userId:${ctx.user.id}`);
    await handlePostback(ctx);
    return;
  }

  if (ctx.message.attachments.length > 0) {
    log.debug(
      `Dispatching to handleAttachment | userId:${ctx.user.id} ` +
      `| count:${ctx.message.attachments.length}`
    );
    await handleAttachment(ctx);
    return;
  }

  if (ctx.message.text) {
    log.debug(`Dispatching to handleText | userId:${ctx.user.id}`);
    await handleText(ctx);
    return;
  }

  // Empty event (read receipts, etc.)
  log.debug(`Message has no actionable content — skipping. | userId:${ctx.user.id}`);
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleText(ctx: Context): Promise<void> {
  if (!pipeline) {
    log.warn("CommandPipeline not wired — echoing raw text.", {
      userId: ctx.user.id,
      text:   ctx.message.text,
    });
    await ctx.reply(`استقبلت: ${ctx.message.text}`);
    return;
  }
  await pipeline.run(ctx);
}

async function handleAttachment(ctx: Context): Promise<void> {
  log.debug("handleAttachment: no handler implemented yet.", {
    userId: ctx.user.id,
    types:  ctx.message.attachments.map((a) => a.type),
  });
  await ctx.reply("تم استقبال المرفق.");
}

async function handlePostback(ctx: Context): Promise<void> {
  log.debug("handlePostback: no handler implemented yet.", {
    userId:  ctx.user.id,
    payload: ctx.message.postbackPayload,
  });
  await ctx.reply(`Postback: ${ctx.message.postbackPayload}`);
}
