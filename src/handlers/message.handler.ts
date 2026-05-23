import { MessagingEntry } from "../types";
import { messengerService } from "../services/messenger.service";
import { ContextBuilder } from "../context/ContextBuilder";
import { Context } from "../context/Context";

const contextBuilder = new ContextBuilder(messengerService);

export async function handleMessage(event: MessagingEntry): Promise<void> {
  const ctx = contextBuilder.build(event);
  await dispatch(ctx);
}

async function dispatch(ctx: Context): Promise<void> {
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
  await ctx.typingOn();
  await ctx.reply(`استقبلت: ${ctx.message.text}`);
}

async function handleAttachment(ctx: Context): Promise<void> {
  await ctx.reply("تم استقبال المرفق.");
}

async function handlePostback(ctx: Context): Promise<void> {
  await ctx.reply(`Postback: ${ctx.message.postbackPayload}`);
}
