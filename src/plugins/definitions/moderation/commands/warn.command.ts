import { ICommand }      from "../../../../commands/types/ICommand";
import { IPluginContext } from "../../../types/IPluginContext";
import { IModerationService, IResponseBuilder, MOD_SERVICES } from "../services/IModerationService";

export function createWarnCommand(pluginCtx: IPluginContext): ICommand {
  return {
    name: "warn", aliases: ["warning"],
    description: "يصدر تحذيراً — بعد الحد الأقصى يُحظر تلقائياً",
    usage: "/warn <userId> [reason]",
    category: "moderation", adminOnly: true, minArgs: 1,

    async execute(ctx) {
      const svc    = pluginCtx.requireService<IModerationService>(MOD_SERVICES.MODERATION);
      const fmt    = pluginCtx.consumeService<IResponseBuilder>(MOD_SERVICES.RESPONSE_BUILDER);
      const userId = ctx.getArg(0)!.trim();
      const reason = ctx.getRemainingText(1) || undefined;
      try {
        const result = await svc.warn(userId, ctx.user.id, reason);
        const lines = [
          `🆔 المستخدم:   ${userId}`,
          reason ? `📝 السبب:      ${reason}` : "",
          `⚠️  التحذيرات:  ${result.warnCount ?? "—"}`,
          result.autoBanned ? "🚫 تم الحظر التلقائي بسبب تجاوز الحد." : "",
          `👮 بواسطة:    ${ctx.user.id}`,
        ].filter(Boolean);
        await ctx.reply(fmt ? fmt.success("تم إصدار التحذير", lines) : lines.join("\n"));
      } catch (err) {
        pluginCtx.logger.error("warn command failed.", err);
        await ctx.reply(fmt?.warn("فشل إصدار التحذير.") ?? "⚠️ فشل التحذير.");
      }
    },
  };
}
