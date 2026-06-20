import { IPlugin, PluginManifest } from "../../types/IPlugin";
import { IPluginContext }          from "../../types/IPluginContext";
import { ICommand }                from "../../../commands/types/ICommand";
import { Context }                 from "../../../context/Context";
import {
  fetchThreadInfo,
  setAdminStatus,
  type FcaThreadInfo as ThreadInfo,
  type FcaThreadAdminEntry as ThreadAdminEntry,
  type FcaThreadUserInfo as ThreadUserInfo,
  type IFcaApiWithAdmin as IFcaApiAdmin,
} from "../../../facebook/fcaHelpers";

// ─── Extended FCA types (declared locally — no changes to FcaTypes.ts) ──────

interface IMiraiTransportService {
  getApi(): IFcaApiAdmin | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const HEADER = "⸪⟅𝐕̶݈̂͜𝔈̟͢⃟݃།̶𝝬̶۪͛ۡ⸸𝚬̱̩⩨ܵ𝐁᮫͎ܺ݀ࣸ᷼᷍⃢ː𝚶̶݄݈݊𝐓݂ ❈ 🦢";

function getApi(pluginCtx: IPluginContext): IFcaApiAdmin | null {
  const primary = pluginCtx.consumeService<IMiraiTransportService>("mirai-transport")?.getApi?.() ?? null;
  if (primary) return primary;
  return pluginCtx.consumeService<IMiraiTransportService>("mirai-transport-secondary")?.getApi?.() ?? null;
}

/** Resolve a list-position (1-based) or raw FB ID from a string arg. */
function resolveTarget(
  arg:      string | undefined,
  adminIDs: string[],
): string | null {
  if (!arg) return null;

  const num = parseInt(arg, 10);
  if (!isNaN(num) && num >= 1 && num <= adminIDs.length) {
    return adminIDs[num - 1] ?? null;
  }

  // Treat as a raw Facebook ID
  if (/^\d+$/.test(arg)) return arg;

  return null;
}

// ─── Sub-handlers ────────────────────────────────────────────────────────────

async function handleListAdmins(
  ctx:       Context,
  pluginCtx: IPluginContext,
): Promise<void> {
  await ctx.typingOn();

  const api = getApi(pluginCtx);
  if (!api) {
    await ctx.reply("⚠️ خدمة Facebook غير متاحة حالياً.");
    return;
  }

  let info: ThreadInfo;
  try {
    info = await fetchThreadInfo(api, ctx.thread.id);
  } catch (err) {
    pluginCtx.logger.warn("ادمن: getThreadInfo failed.", { error: String(err) });
    await ctx.reply("⚠️ تعذّر جلب معلومات القروب. تأكد أن البوت مضاف ويملك الصلاحيات.");
    return;
  }

  if (!info.isGroup) {
    await ctx.reply("⚠️ هذا الأمر يعمل في القروبات فقط.");
    return;
  }

  const adminIDs = info.adminIDs.map((a) => a.id);

  if (adminIDs.length === 0) {
    await ctx.reply(`${HEADER}\n\n⌯ لا يوجد أدمن في هذا القروب.`);
    return;
  }

  const lines = adminIDs.map((id, i) => {
    const name = info.userInfo[id]?.name ?? id;
    return `${i + 1} - ${name} (${id})`;
  });

  const msg = [
    HEADER,
    "",
    `⌯ اسم القروب: ${info.name || "غير معروف"}`,
    `⌯ عدد الأدمن: ${adminIDs.length}`,
    "",
    "⌯ الأدمن:",
    ...lines,
  ].join("\n");

  await ctx.reply(msg);
}

async function handleAddAdmin(
  ctx:       Context,
  pluginCtx: IPluginContext,
): Promise<void> {
  await ctx.typingOn();

  const api = getApi(pluginCtx);
  if (!api) {
    await ctx.reply("⚠️ خدمة Facebook غير متاحة حالياً.");
    return;
  }

  // Check group
  let info: ThreadInfo;
  try {
    info = await fetchThreadInfo(api, ctx.thread.id);
  } catch {
    await ctx.reply("⚠️ تعذّر جلب معلومات القروب.");
    return;
  }

  if (!info.isGroup) {
    await ctx.reply("⚠️ هذا الأمر يعمل في القروبات فقط.");
    return;
  }

  // Verify caller is a group admin or bot admin
  const callerIsGroupAdmin = info.adminIDs.some((a) => a.id === ctx.user.id);
  if (!callerIsGroupAdmin && !ctx.hasRole("admin")) {
    await ctx.reply("⚠️ هذا الأمر للأدمن فقط.");
    return;
  }

  // arg(1) because arg(0) is "اضافة"
  const targetId = ctx.getArg(1);
  if (!targetId || !/^\d+$/.test(targetId)) {
    await ctx.reply("⚠️ الرجاء تحديد معرّف (ID) المستخدم.\n مثال: ادمن اضافة 1234567890");
    return;
  }

  // Check if already admin
  if (info.adminIDs.some((a) => a.id === targetId)) {
    const name = info.userInfo[targetId]?.name ?? targetId;
    await ctx.reply(`ℹ️ ${name} هو أدمن بالفعل.`);
    return;
  }

  // Check if in group
  if (!info.participantIDs.includes(targetId)) {
    await ctx.reply("⚠️ هذا المستخدم ليس في القروب.");
    return;
  }

  try {
    await setAdminStatus(api, ctx.thread.id, [targetId], true);
    const name = info.userInfo[targetId]?.name ?? targetId;
    await ctx.reply(`✅ تم تعيين ${name} (${targetId}) أدمناً بنجاح.`);
  } catch (err) {
    pluginCtx.logger.warn("ادمن: changeAdminStatus (add) failed.", { error: String(err) });
    await ctx.reply("⚠️ فشل تعيين الأدمن. تأكد أن البوت يملك صلاحية الأدمن في القروب.");
  }
}

async function handleRemoveAdmin(
  ctx:       Context,
  pluginCtx: IPluginContext,
): Promise<void> {
  await ctx.typingOn();

  const api = getApi(pluginCtx);
  if (!api) {
    await ctx.reply("⚠️ خدمة Facebook غير متاحة حالياً.");
    return;
  }

  // Check group
  let info: ThreadInfo;
  try {
    info = await fetchThreadInfo(api, ctx.thread.id);
  } catch {
    await ctx.reply("⚠️ تعذّر جلب معلومات القروب.");
    return;
  }

  if (!info.isGroup) {
    await ctx.reply("⚠️ هذا الأمر يعمل في القروبات فقط.");
    return;
  }

  // Verify caller is a group admin or bot admin
  const callerIsGroupAdmin = info.adminIDs.some((a) => a.id === ctx.user.id);
  if (!callerIsGroupAdmin && !ctx.hasRole("admin")) {
    await ctx.reply("⚠️ هذا الأمر للأدمن فقط.");
    return;
  }

  const adminIDs = info.adminIDs.map((a) => a.id);
  // arg(1) because arg(0) is "حذف"
  const targetId = resolveTarget(ctx.getArg(1), adminIDs);
  if (!targetId) {
    await ctx.reply(
      "⚠️ الرجاء تحديد رقم الأدمن من القائمة أو معرّفه.\n" +
      " مثال: ادمن حذف 2\n" +
      " أو:    ادمن حذف 1234567890"
    );
    return;
  }

  if (!info.adminIDs.some((a) => a.id === targetId)) {
    await ctx.reply("⚠️ هذا المستخدم ليس أدمناً في القروب.");
    return;
  }

  try {
    await setAdminStatus(api, ctx.thread.id, [targetId], false);
    const name = info.userInfo[targetId]?.name ?? targetId;
    await ctx.reply(`✅ تم إزالة صلاحية الأدمن من ${name} (${targetId}) بنجاح.`);
  } catch (err) {
    pluginCtx.logger.warn("ادمن: changeAdminStatus (remove) failed.", { error: String(err) });
    await ctx.reply("⚠️ فشل إزالة الأدمن. تأكد أن البوت يملك صلاحية الأدمن في القروب.");
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

class AdminPlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name:        "admin",
    version:     "1.0.0",
    description: "عرض قائمة الأدمن في القروب وإدارتهم (إضافة/حذف).",
    author:      "Sixseven-6677",
  };

  private ctx!: IPluginContext;

  async onLoad(ctx: IPluginContext): Promise<void> {
    this.ctx = ctx;
    ctx.logger.info("AdminPlugin loaded.");
  }

  async onEnable(): Promise<void> {
    const pluginCtx = this.ctx;

    // Close over pluginCtx so sub-handlers can access the service registry
    const adminCommand: ICommand = {
      name:        "ادمن",
      aliases:     ["admins", "adminlist", "ادمنز"],
      description: "عرض قائمة الأدمن في القروب وإدارتهم",
      usage:       "ادمن | ادمن اضافة [id] | ادمن حذف [رقم/id]",
      category:    "admin",
      adminOnly:   false,
      hidden:      false,

      async execute(ctx: Context): Promise<void> {
        const subCmd = ctx.getArg(0);
        if (subCmd === "اضافة" || subCmd === "add") {
          await handleAddAdmin(ctx, pluginCtx);
        } else if (subCmd === "حذف" || subCmd === "remove") {
          await handleRemoveAdmin(ctx, pluginCtx);
        } else {
          await handleListAdmins(ctx, pluginCtx);
        }
      },
    };

    pluginCtx.registerCommand(adminCommand);
    pluginCtx.logger.info(
      `Command "${adminCommand.name}" registered ` +
      `(aliases: ${adminCommand.aliases?.join(", ")}).`
    );
  }

  async onDisable(): Promise<void> {
    this.ctx.logger.info("AdminPlugin disabled.");
  }

  async onUnload(): Promise<void> {
    this.ctx.logger.info("AdminPlugin unloaded.");
  }
}

export default new AdminPlugin();
