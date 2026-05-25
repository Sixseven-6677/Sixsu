import { ICommand }      from "../../../../commands/types/ICommand";
import { IPluginContext } from "../../../types/IPluginContext";
import { IModerationService, IResponseBuilder, MOD_SERVICES, parseModArgs, fmtDuration } from "../services/IModerationService";

export function createBanCommand(pluginCtx: IPluginContext): ICommand {
  return {
    name: "ban", aliases: ["block"],
    description: "يحظر مستخدماً من استخدام البوت",
    usage: "/ban <userId> [duration: 30m] [reason]",
    category: "moderation", adminOnly: true, minArgs: 1,

    async execute(ctx) {
      const svc = pluginCtx.requireService<IModerationService>(MOD_SERVICES.MODERATION);
      const fmt = pluginCtx.consumeService<IResponseBuilder>(MOD_SERVICES.RESPONSE_BUILDER);
      const { userId, durationMs, reason } = parseModArgs(ctx.args);

      if (!userId) {
        await ctx.reply(fmt?.warn("يُرجى تحديد معرّف المستخدم.") ?? "⚠️ userId مطلوب.");
        return;
      }
      try {
        const result = await svc.ban(userId, ctx.user.id, { durationMs, reason });
        if (!result.ok) { await ctx.reply(fmt?.warn(result.message) ?? `⚠️ ${result.message}`); return; }
        const lines = [
          `🆔 المستخدم:  ${userId}`,
          `🕐 المدة:     ${durationMs ? fmtDuration(durationMs) : "دائماً"}`,
          reason ? `📝 السبب:     ${reason}` : "",
          `👮 بواسطة:   ${ctx.user.id}`,
        ].filter(Boolean);
        await ctx.reply(fmt ? fmt.success("تم تطبيق الحظر", lines) : lines.join("\n"));
      } catch (err) {
        pluginCtx.logger.error("ban command failed.", err);
        await ctx.reply(fmt?.warn("فشل تطبيق الحظر. راجع السجلات.") ?? "⚠️ فشل الحظر.");
      }
    },
  };
}
