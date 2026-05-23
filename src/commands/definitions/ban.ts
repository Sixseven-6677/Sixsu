import { ICommand }  from "../types/ICommand";
import { getBanStore } from "../../handlers/message.handler";

export const command: ICommand = {
  name:        "ban",
  aliases:     ["block"],
  description: "يحظر مستخدماً من استخدام البوت",
  usage:       "/ban <userId> [--reason=<text>] [--duration=<minutes>]",
  category:    "admin",
  adminOnly:   true,
  minArgs:     1,

  execute: async (ctx) => {
    const store = getBanStore();
    if (!store) {
      await ctx.reply("⚠️ BanStore غير متاح.");
      return;
    }

    const userId   = ctx.getArg(0)!;
    const rawText  = ctx.getRemainingText(1);

    // Extract --reason=... and --duration=...
    const reasonMatch   = rawText.match(/--reason=([^\s-][^\-]*?)(?:\s+--|$)/);
    const durationMatch = rawText.match(/--duration=(\d+)/);

    const reason     = reasonMatch?.[1]?.trim();
    const durationMs = durationMatch
      ? parseInt(durationMatch[1]!) * 60_000
      : undefined;

    store.ban(userId, {
      reason,
      durationMs,
      bannedBy: ctx.user.id,
    });

    const expiry = durationMs
      ? `لمدة ${durationMatch![1]} دقيقة`
      : "دائماً";

    await ctx.reply(
      `✅ تم حظر المستخدم [${userId}].\n` +
      `🕐 المدة: ${expiry}\n` +
      (reason ? `📝 السبب: ${reason}` : "")
    );
  },
};
