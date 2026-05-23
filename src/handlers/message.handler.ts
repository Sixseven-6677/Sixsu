import { Context }          from "../context/Context";
import { CommandPipeline }  from "../commands/CommandPipeline";
import { CommandRegistry }  from "../commands/CommandRegistry";
import { TaskScheduler }    from "../scheduler";
import { ReconnectManager } from "../facebook/reconnect/ReconnectManager";

let pipeline:         CommandPipeline  | undefined;
let registry:         CommandRegistry  | undefined;
let scheduler:        TaskScheduler    | undefined;
let reconnectManager: ReconnectManager | undefined;

export function setCommandPipeline(p: CommandPipeline): void  { pipeline         = p; }
export function setCommandRegistry(r: CommandRegistry): void  { registry         = r; }
export function setTaskScheduler(s: TaskScheduler): void      { scheduler        = s; }
export function setReconnectManager(r: ReconnectManager): void { reconnectManager = r; }

export function getCommandPipeline():  CommandPipeline  | undefined { return pipeline;         }
export function getCommandRegistry():  CommandRegistry  | undefined { return registry;         }
export function getTaskScheduler():    TaskScheduler    | undefined { return scheduler;        }
export function getReconnectManager(): ReconnectManager | undefined { return reconnectManager; }

export async function handleMessage(ctx: Context): Promise<void> {
  if (ctx.message.isPostback) {
    await handlePostback(ctx);
    return;
  }

  if (ctx.message.attachments.length > 0) {
    await handleAttachment(ctx);
    return;
  }

  if (ctx.message.text) {
    await handleText(ctx);
    return;
  }
}

async function handleText(ctx: Context): Promise<void> {
  if (pipeline) {
    await pipeline.run(ctx);
    return;
  }
  await ctx.reply(`استقبلت: ${ctx.message.text}`);
}

async function handleAttachment(ctx: Context): Promise<void> {
  await ctx.reply("تم استقبال المرفق.");
}

async function handlePostback(ctx: Context): Promise<void> {
  await ctx.reply(`Postback: ${ctx.message.postbackPayload}`);
}
