import { Context } from "../context/Context";
import { CommandPipeline } from "../commands/CommandPipeline";
import { TaskScheduler } from "../scheduler";

let pipeline: CommandPipeline | undefined;
let scheduler: TaskScheduler | undefined;

export function setCommandPipeline(p: CommandPipeline): void {
  pipeline = p;
}

export function setTaskScheduler(s: TaskScheduler): void {
  scheduler = s;
}

export function getTaskScheduler(): TaskScheduler | undefined {
  return scheduler;
}

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
