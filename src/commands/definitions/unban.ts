import { ICommand }   from "../types/ICommand";
import { getBanStore } from "../../handlers/message.handler";

export const command: ICommand = {
  name:        "unban",
  aliases:     ["unblock"],
  description: "يرفع الحظر عن مستخدم",
  usage:       "/unban <userId>",
  category:    "admin",
  adminOnly:   true,
  minArgs:     1,

  execute: async (ctx) => {
    const store = getBanStore();
    if (!store) {
      await ctx.reply("⚠️ BanStore غير متاح.");
      return;
    }

    const userId = ctx.getArg(0)!;
    const ok     = store.unban(userId);

    await ctx.reply(
      ok
        ? `✅ تم رفع الحظر عن المستخدم [${userId}].`
        : `❓ المستخدم [${userId}] غير محظور.`
    );
  },
};
