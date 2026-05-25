import { ICommand }      from "../../../../commands/types/ICommand";
import { IPluginContext } from "../../../types/IPluginContext";
import { IModerationService, IResponseBuilder, MOD_SERVICES } from "../services/IModerationService";

export function createUnbanCommand(pluginCtx: IPluginContext): ICommand {
  return {
    name: "unban", aliases: ["unblock"],
    description: "يرفع الحظر عن مستخدم",
    usage: "/unban <userId>",
    category: "moderation", adminOnly: true, minArgs: 1,

    async execute(ctx) {
      const svc    = pluginCtx.requireService<IModerationService>(MOD_SERVICES.MODERATION);
      const fmt    = pluginCtx.consumeService<IResponseBuilder>(MOD_SERVICES.RESPONSE_BUILDER);
      const userId = ctx.getArg(0)!.trim();
      try {
        const result = await svc.unban(userId, ctx.user.id);
        if (!result.ok) { await ctx.reply(fmt?.warn(result.message) ?? `⚠️ ${result.message}`); return; }
        const lines = [`🆔 المستخدم:  ${userId}`, `👮 بواسطة:   ${ctx.user.id}`];
        await ctx.reply(fmt ? fmt.success("تم رفع الحظر", lines) : lines.join("\n"));
      } catch (err) {
        pluginCtx.logger.error("unban command failed.", err);
        await ctx.reply(fmt?.warn("فشل رفع الحظر.") ?? "⚠️ فشل رفع الحظر.");
      }
    },
  };
}
