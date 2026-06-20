import { Context }          from "../context/Context";
import { CommandPipeline }  from "../commands/CommandPipeline";
import { CommandRegistry }  from "../commands/CommandRegistry";
import { TaskScheduler }    from "../scheduler";
import { ReconnectManager } from "../facebook/reconnect/ReconnectManager";
import { BanStore }         from "../middleware/built-in/banned.middleware";
import type { IUserService } from "../users/types/IUserService";
import { LoggerManager }    from "../logger/LoggerManager";

const log = LoggerManager.getLogger("MessageHandler");

// ─── MessageHandler class ─────────────────────────────────────────────────────

export class MessageHandler {
  constructor(
    private readonly pipeline:         CommandPipeline,
    private readonly registry:         CommandRegistry,
    private readonly scheduler:        TaskScheduler,
    private readonly reconnectManager: ReconnectManager,
    private readonly banStore:         BanStore,
    private readonly userService:      IUserService | undefined,
  ) {}

  get commandPipeline():  CommandPipeline  { return this.pipeline; }
  get commandRegistry():  CommandRegistry  { return this.registry; }
  get taskScheduler():    TaskScheduler    { return this.scheduler; }
  get reconnect():        ReconnectManager { return this.reconnectManager; }
  get bans():             BanStore         { return this.banStore; }
  get users():            IUserService | undefined { return this.userService; }

  handle = async (ctx: Context): Promise<void> => {
    const msgType = ctx.message.isPostback
      ? "postback"
      : ctx.message.attachments.length > 0
        ? "attachment"
        : ctx.message.text
          ? "text"
          : "empty";

    log.info("MessageHandler: routing message.", {
      userId:          ctx.user.id,
      role:            ctx.user.role,
      msgType,
      text:            (ctx.message.text ?? "").slice(0, 80),
      attachmentCount: ctx.message.attachments.length,
      postbackPayload: ctx.message.postbackPayload?.slice(0, 80),
    });

    if (ctx.message.isPostback) {
      await this.handlePostback(ctx);
      return;
    }

    if (ctx.message.attachments.length > 0) {
      log.debug("MessageHandler: attachment received — ignoring.", {
        userId: ctx.user.id,
        types:  ctx.message.attachments.map((a) => a.type),
      });
      return;
    }

    if (ctx.message.text) {
      await this.handleText(ctx);
      return;
    }

    log.debug("MessageHandler: message has no actionable content — skipping.", {
      userId: ctx.user.id,
    });
  };

  private async handleText(ctx: Context): Promise<void> {
    log.info("MessageHandler: entering command pipeline.", {
      userId:      ctx.user.id,
      commandName: ctx.commandName ?? "(none)",
      text:        (ctx.message.text ?? "").slice(0, 80),
    });
    await this.pipeline.run(ctx);
  }

  private async handlePostback(ctx: Context): Promise<void> {
    log.info("MessageHandler: postback received.", {
      userId:  ctx.user.id,
      payload: ctx.message.postbackPayload,
    });
    await ctx.reply(`Postback: ${ctx.message.postbackPayload}`);
  }
}

// ─── Backward-compat singleton wiring (used by index.ts during transition) ───
// These will be removed once index.ts is decomposed into bootstrap/ modules.

let _handler: MessageHandler | undefined;

export function createMessageHandler(
  pipeline:         CommandPipeline,
  registry:         CommandRegistry,
  scheduler:        TaskScheduler,
  reconnectManager: ReconnectManager,
  banStore:         BanStore,
  userService:      IUserService | undefined,
): MessageHandler {
  _handler = new MessageHandler(pipeline, registry, scheduler, reconnectManager, banStore, userService);
  return _handler;
}

export function getMessageHandler(): MessageHandler {
  if (!_handler) throw new Error("MessageHandler not initialised — call createMessageHandler() first.");
  return _handler;
}

/** Entry point for FCA event adapter (bound to handler.handle) */
export async function handleMessage(ctx: Context): Promise<void> {
  if (!_handler) {
    log.warn("MessageHandler: not initialised — dropping message.", { userId: ctx.user.id });
    return;
  }
  return _handler.handle(ctx);
}
