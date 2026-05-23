import { ICommand }           from "../types/ICommand";
import { getCommandRegistry } from "../../handlers/message.handler";

export const command: ICommand = {
  name:        "help",
  aliases:     ["h", "?"],
  description: "يعرض قائمة الأوامر المتاحة أو تفاصيل أمر محدد",
  usage:       "/help [command]",
  category:    "general",

  execute: async (ctx) => {
    const reg = getCommandRegistry();
    if (!reg) {
      await ctx.reply("⚠️ CommandRegistry غير متاح.");
      return;
    }

    // /help <command> — show details for a single command
    const target = ctx.getArg(0);
    if (target) {
      const cmd = reg.resolve(target.toLowerCase());
      if (!cmd) {
        await ctx.reply(`❓ الأمر "${target}" غير موجود.`);
        return;
      }

      const lines: string[] = [
        `📌 ${cmd.name}`,
        cmd.description ? `   ${cmd.description}` : "",
        cmd.usage       ? `📎 الاستخدام: ${cmd.usage}` : "",
        cmd.aliases?.length
          ? `🔤 المختصرات: ${cmd.aliases.join(", ")}`
          : "",
        cmd.category    ? `🏷️ الفئة: ${cmd.category}` : "",
        cmd.cooldownMs  ? `⏱️ Cooldown: ${cmd.cooldownMs / 1000}s` : "",
        cmd.minArgs     ? `📥 حد أدنى للمُدخلات: ${cmd.minArgs}` : "",
        cmd.adminOnly   ? "🔒 للمشرفين فقط" : "",
      ].filter(Boolean);

      await ctx.reply(lines.join("\n"));
      return;
    }

    // /help — list all commands grouped by category
    const byCategory = reg.byCategory();

    if (byCategory.size === 0) {
      await ctx.reply("📭 لا توجد أوامر مسجّلة حالياً.");
      return;
    }

    const sections: string[] = [];

    for (const [cat, cmds] of byCategory) {
      const header = `【 ${cat.toUpperCase()} 】`;
      const list   = cmds
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => `  • ${c.name}${c.aliases?.length ? ` (${c.aliases.join(", ")})` : ""} — ${c.description ?? "—"}`)
        .join("\n");
      sections.push(`${header}\n${list}`);
    }

    const total = reg.getAll().filter((c) => !c.hidden).length;
    const footer = `\n─────────────────────\n📊 ${total} أمر متاح | /help <command> للتفاصيل`;

    await ctx.reply(sections.join("\n\n") + footer);
  },
};
