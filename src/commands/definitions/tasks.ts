import { ICommand } from "../types/ICommand";
import { getTaskScheduler } from "../../handlers/message.handler";

export const command: ICommand = {
  name: "tasks",
  aliases: ["sched", "scheduler"],
  description: "إدارة جدولة المهام — عرض الحالة أو إلغاء مهمة",
  usage: "/tasks [list|stats|cancel <id>|demo]",

  execute: async (ctx) => {
    const scheduler = getTaskScheduler();
    if (!scheduler) {
      await ctx.reply("⚠️ TaskScheduler غير مُفعَّل.");
      return;
    }

    const sub = ctx.getArg(0)?.toLowerCase() ?? "list";

    if (sub === "stats") {
      const s = scheduler.stats();
      await ctx.reply(
        `📊 إحصائيات المهام:\n` +
        `• المجموع: ${s.total}\n` +
        `• النشطة:  ${s.active}\n` +
        `• الفاشلة: ${s.failed}`
      );
      return;
    }

    if (sub === "cancel") {
      const id = ctx.getArg(1);
      if (!id) {
        await ctx.reply("⚠️ أرسل معرّف المهمة: /tasks cancel <id>");
        return;
      }
      const ok = scheduler.cancel(id);
      await ctx.reply(
        ok
          ? `✅ تم إلغاء المهمة [${id}].`
          : `❌ لم يُعثر على مهمة بالمعرّف [${id}].`
      );
      return;
    }

    if (sub === "demo") {
      const delayed = scheduler.delay({
        name: "demo-delayed",
        delayMs: 5_000,
        fn: async () => {
          await ctx.reply("⏰ تنفيذ المهمة المؤجلة (5 ثوانٍ)!");
        },
      });

      scheduler.recur({
        id: `demo-recur-${ctx.user.id}`,
        name: "demo-recurring",
        intervalMs: 10_000,
        maxRuns: 3,
        runImmediately: false,
        fn: async () => {
          await ctx.reply("🔁 تنفيذ دوري (كل 10 ثوانٍ، 3 مرات فقط)");
        },
      });

      await ctx.reply(
        `✅ تم إنشاء مهمتَين تجريبيتَين:\n` +
        `• مؤجلة 5 ثوانٍ  [${delayed.id.slice(0, 8)}...]\n` +
        `• دورية كل 10 ثوانٍ (3 مرات)`
      );
      return;
    }

    const tasks = scheduler.active();
    if (tasks.length === 0) {
      await ctx.reply("📭 لا توجد مهام نشطة حالياً.");
      return;
    }

    const lines = tasks.map((t, i) => {
      const next = t.nextRunAt
        ? `بعد ${Math.max(0, Math.round((t.nextRunAt.getTime() - Date.now()) / 1000))}s`
        : "—";
      return `${i + 1}. ${t.name} | runs: ${t.runCount} | next: ${next} | [${t.id.slice(0, 8)}...]`;
    });

    await ctx.reply(`📋 المهام النشطة (${tasks.length}):\n` + lines.join("\n"));
  },
};
