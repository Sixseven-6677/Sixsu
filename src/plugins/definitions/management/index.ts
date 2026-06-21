import { config }          from "../../../config/env";
import { prefixStore }    from "../../../prefix/PrefixStore";
import { IPlugin, PluginManifest } from "../../types/IPlugin";
import { IPluginContext }          from "../../types/IPluginContext";
import { ICommand }                from "../../../commands/types/ICommand";
import { Context }                 from "../../../context/Context";
import {
  setProtectionStore,
  getProtectionSummary,
  ThreadState,
  ProtectionStore,
} from "../../../protection/ProtectionRegistry";
import {
  logProtectionEnabled,
  logProtectionDisabled,
} from "../../../handlers/group.handler";

// ─── Extended FCA types ──────────────────────────────────────────────────────

interface ThreadUserInfo {
  name:       string;
  firstName?: string;
}

interface ThreadInfo {
  threadID:       string;
  participantIDs: string[];
  adminIDs:       Array<{ id: string }>;
  name:           string;
  isGroup:        boolean;
  userInfo:       Record<string, ThreadUserInfo>;
  nicknames?:     Record<string, string | null>;
}

interface IFcaManagement {
  getCurrentUserID(): string;
  getThreadInfo(
    threadID: string,
    callback: (err: Error | null, info: ThreadInfo) => void,
  ): void;
  setTitle(
    newTitle: string,
    threadID: string,
    callback: (err: Error | null) => void,
  ): void;
  changeNickname(
    nickname:      string,
    threadID:      string,
    participantID: string,
    callback?:     (err: Error | null) => void,
  ): void;
}

interface IMiraiService {
  getApi(): IFcaManagement | null;
  isConnected(): boolean;
}

// ─── GroupSettings repository interface (loose coupling) ─────────────────────

interface IGroupSettingsRepository {
  findAll(): Promise<Array<{
    threadId:         string;
    protectName:      boolean;
    lockedName:       string;
    protectNicknames: boolean;
    nicknames:        Record<string, string>;
    botNickname:      string;
    lockdown:         boolean;
  }>>;
  upsert(threadId: string, data: {
    protectName?:      boolean;
    lockedName?:       string;
    protectNicknames?: boolean;
    nicknames?:        Record<string, string>;
    botNickname?:      string;
    lockdown?:         boolean;
  }): Promise<unknown>;
}


// ─── MongoDB load with retry ───────────────────────────────────────────────────

/**
 * Attempts to load protection state from MongoDB with retries.
 * On Railway, MongoDB may not be immediately available on startup — retrying
 * ensures we don't fall back to an empty file-based state unnecessarily.
 */
async function loadFromMongoWithRetry(
  repo: IGroupSettingsRepository,
  log:  { info(m: string, o?: object): void; warn(m: string, o?: object): void },
  maxAttempts = 3,
  retryDelayMs = 2_000,
): Promise<ProtectionStore | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const docs  = await repo.findAll();
      const store: ProtectionStore = { threads: {}, botNicknames: {} };

      for (const d of docs) {
        store.threads[d.threadId] = {
          protectName:      d.protectName,
          lockedName:       d.lockedName,
          protectNicknames: d.protectNicknames,
          nicknames:        d.nicknames,
        };
        if (d.botNickname) {
          store.botNicknames[d.threadId] = d.botNickname;
        }
      }

      log.info("ManagementPlugin: protection state loaded from MongoDB.", {
        attempt,
        savedThreads:   Object.keys(store.threads).length,
        protectedNames: Object.values(store.threads).filter(s => s.protectName).length,
        protectedBots:  Object.keys(store.botNicknames).length,
      });
      return store;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        log.warn(
          `ManagementPlugin: MongoDB load failed (attempt ${attempt}/${maxAttempts}) — retrying in ${retryDelayMs}ms.`,
          { error: msg },
        );
        await new Promise<void>((r) => setTimeout(r, retryDelayMs));
      } else {
        log.warn(
          `ManagementPlugin: MongoDB load failed after ${maxAttempts} attempts — falling back to file.`,
          { error: msg },
        );
      }
    }
  }
  return null;
}

// ─── Thread state helpers ─────────────────────────────────────────────────────

function getThreadState(data: ProtectionStore, threadID: string): ThreadState {
  if (!data.threads[threadID]) {
    data.threads[threadID] = {
      protectName:      false,
      lockedName:       "",
      protectNicknames: false,
      nicknames:        {},
    };
  }
  return data.threads[threadID]!;
}

function saveThreadState(
  store:    ProtectionStore,
  threadId: string,
  repo:     IGroupSettingsRepository | null,
  logger:   IPluginContext['logger'],
): void {
  if (!repo) return;
  const state = store.threads[threadId];
  if (!state) return;
  repo.upsert(threadId, {
    protectName:      state.protectName,
    lockedName:       state.lockedName,
    protectNicknames: state.protectNicknames,
    nicknames:        state.nicknames,
    botNickname:      store.botNicknames[threadId] ?? '',
  }).catch((err: unknown) => {
    logger.warn('saveThreadState: failed to persist to MongoDB.', {
      threadId, error: String(err),
    });
  });
}


// ─── FCA promise wrappers ─────────────────────────────────────────────────────

function fcaGetThreadInfo(api: IFcaManagement, threadID: string): Promise<ThreadInfo> {
  return new Promise((resolve, reject) => {
    api.getThreadInfo(threadID, (err, info) => {
      if (err) reject(err); else resolve(info);
    });
  });
}

function fcaSetTitle(api: IFcaManagement, title: string, threadID: string): Promise<void> {
  return new Promise((resolve, reject) => {
    api.setTitle(title, threadID, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

function fcaChangeNickname(
  api: IFcaManagement, nick: string, threadID: string, userID: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    api.changeNickname(nick, threadID, userID, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Shared utilities ─────────────────────────────────────────────────────────

const HEADER = "⸪⟅𝐕̶݈̂͜𝔈̟͢⃟݃།̶𝝬̶۪͛ۡ⸸𝚬̱̩⩨ܵ𝐁᮫͎ܺ݀ࣸ᷼᷍⃢ː𝚶̶݄݈݊𝐓݂ ❈ 🦢";

function getApi(pCtx: IPluginContext): IFcaManagement | null {
  const primary = pCtx.consumeService<IMiraiService>("mirai-transport")?.getApi?.() ?? null;
  if (primary) return primary;
  return pCtx.consumeService<IMiraiService>("mirai-transport-secondary")?.getApi?.() ?? null;
}

async function assertGroupAdmin(
  ctx:  Context,
  api:  IFcaManagement,
  pCtx: IPluginContext,
): Promise<ThreadInfo | null> {
  let info: ThreadInfo;
  try {
    info = await fcaGetThreadInfo(api, ctx.thread.id);
  } catch (err) {
    pCtx.logger.warn("assertGroupAdmin: getThreadInfo failed.", { error: String(err) });
    await ctx.reply("⚠️ تعذّر جلب معلومات القروب. تأكد أن البوت مضاف للقروب.");
    return null;
  }

  if (!info.isGroup) {
    await ctx.reply("⚠️ هذا الأمر يعمل في القروبات فقط.");
    return null;
  }

  const isGroupAdmin = info.adminIDs.some((a) => a.id === ctx.user.id);
  const isBotAdmin   = ctx.hasRole("admin");

  if (!isGroupAdmin && !isBotAdmin) {
    await ctx.reply("🚫 هذا الأمر للأدمن فقط.");
    return null;
  }

  return info;
}

// ─── /ادارة → help ───────────────────────────────────────────────────────────

async function showHelp(ctx: Context): Promise<void> {
  const prefix = prefixStore.get();
  await ctx.reply([
    HEADER, "",
    `⌯ اسم قروب — تغيير اسم القروب مع تفعيل الحماية تلقائياً`,
    `  ↳ ${prefix}اسم [الاسم الجديد]`, "",
    `⌯ حماية اغلاق — إيقاف حماية الاسم`,
    `  ↳ ${prefix}حماية اغلاق`, "",
    `⌯ حماية تشغيل — إعادة تفعيل حماية الاسم`,
    `  ↳ ${prefix}حماية تشغيل`, "",
    `⌯ اسم بوت — تغيير اسم البوت في القروب`,
    `  ↳ ${prefix}بوت [الاسم]`, "",
    `⌯ كنية — تعيين كنية لجميع الأعضاء`,
    `  ↳ ${prefix}كنية [الكنية]`, "",
    `⌯ حماية كنيات — تفعيل/إيقاف حماية كنيات الأعضاء`,
    `  ↳ ${prefix}حماية كنيات`,
  ].join("\n"));
}

// ─── Sub-command handlers ─────────────────────────────────────────────────────

/**
 * /اسم [اسم جديد]
 *
 * - يغير اسم القروب إلى الاسم الجديد
 * - يُفعّل الحماية تلقائياً على الاسم الجديد (protectName = true)
 * - يحفظ الاسم الجديد كاسم محمي (lockedName = newName)
 * - يضع lockedName قبل setTitle — البوت يُعرَّف عبر event.changedBy===botId (بدون flags)
 * - أي تغيير خارجي بعدها يُعاد تلقائياً للاسم الجديد
 */
async function handleGroupName(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  await ctx.typingOn();
  const api = getApi(pCtx);
  if (!api) { await ctx.reply("⚠️ خدمة Facebook غير متاحة."); return; }

  const info = await assertGroupAdmin(ctx, api, pCtx);
  if (!info) return;

  const newName = ctx.args.slice(0).join(" ").trim();
  if (!newName) {
    await ctx.reply("⚠️ الرجاء إدخال الاسم الجديد.\nمثال: /اسم اسم القروب الجديد");
    return;
  }

  const threadState = getThreadState(store, ctx.thread.id);
  // ── Enable protection BEFORE setTitle ────────────────────────────────
  threadState.lockedName    = newName; // new protected reference
  threadState.protectName   = true;    // auto-enable protection
  setProtectionStore(store);

  try {
    await fcaSetTitle(api, newName, ctx.thread.id);

    saveThreadState(store, ctx.thread.id, repo, pCtx.logger);

    logProtectionEnabled(ctx.thread.id, newName, ctx.user.id);
    pCtx.logger.info("Group name changed, protection auto-enabled. [protection-active]", {
      threadID: ctx.thread.id,
      by:       ctx.user.id,
      newName,
    });

    await ctx.reply(
      `${HEADER}\n\n` +
      `✅ تم تغيير اسم القروب إلى:\n"${newName}"\n\n` +
      `🔒 تم تفعيل الحماية تلقائياً ضد التغيير الخارجي.`
    );
  } catch (err) {
    // Revert flags on failure — don't leave stale state
    threadState.protectName   = false;
    threadState.lockedName    = "";
    pCtx.logger.warn("setTitle failed.", { error: String(err) });
    await ctx.reply("⚠️ فشل تغيير اسم القروب. تأكد أن البوت أدمن في القروب.");
  }
}

async function handleBotName(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  await ctx.typingOn();
  if (!ctx.hasRole("admin")) {
    await ctx.reply("🚫 هذا الأمر للأدمن فقط.");
    return;
  }

  const api = getApi(pCtx);
  if (!api) { await ctx.reply("⚠️ خدمة Facebook غير متاحة."); return; }

  let info: ThreadInfo;
  try {
    info = await fcaGetThreadInfo(api, ctx.thread.id);
  } catch (err) {
    pCtx.logger.warn("handleBotName: getThreadInfo failed.", { error: String(err) });
    await ctx.reply("⚠️ تعذّر جلب معلومات القروب.");
    return;
  }

  if (!info.isGroup) { await ctx.reply("⚠️ هذا الأمر يعمل في القروبات فقط."); return; }

  const newNick = ctx.args.slice(0).join(" ").trim();
  if (!newNick) {
    const current = store.botNicknames[ctx.thread.id];
    if (current) {
      await ctx.reply(`${HEADER}\n\n🤖 الاسم المحمي الحالي للبوت:\n"${current}"\n\nلتغييره: /بوت [الاسم الجديد]`);
    } else {
      await ctx.reply(`${HEADER}\n\n⚠️ لم يُعيَّن اسم محمي للبوت في هذا القروب.\n\nلتعيينه: /بوت [الاسم]`);
    }
    return;
  }

  const botId = api.getCurrentUserID();
  try {
    await fcaChangeNickname(api, newNick, ctx.thread.id, botId);
    store.botNicknames[ctx.thread.id] = newNick;
    getThreadState(store, ctx.thread.id);
    saveThreadState(store, ctx.thread.id, repo, pCtx.logger);
    pCtx.logger.info("Bot nickname set and protected.", { threadID: ctx.thread.id, botId, newNick });
    await ctx.reply(
      `${HEADER}\n\n✅ تم تعيين اسم البوت وحمايته:\n"${newNick}"\n\n🔒 أي محاولة لتغييره ستُعاد تلقائياً.`
    );
  } catch (err) {
    pCtx.logger.warn("handleBotName: changeNickname failed.", { error: String(err) });
    await ctx.reply("⚠️ فشل تغيير اسم البوت. تأكد أن البوت أدمن في القروب.");
  }
}

async function handleSetNickname(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  await ctx.typingOn();
  const api = getApi(pCtx);
  if (!api) { await ctx.reply("⚠️ خدمة Facebook غير متاحة."); return; }

  const info = await assertGroupAdmin(ctx, api, pCtx);
  if (!info) return;

  const nick = ctx.args.slice(0).join(" ").trim();
  if (!nick) {
    await ctx.reply("⚠️ الرجاء إدخال الكنية.\nمثال: /كنية كنية");
    return;
  }

  const botId   = api.getCurrentUserID();
  const botNick = store.botNicknames[ctx.thread.id] ?? null;
  const participants = info.participantIDs.filter((id) => id !== botId);

  await ctx.reply(`⏳ جارٍ تعيين الكنية لـ ${participants.length} عضو...`);

  let ok = 0, failed = 0;
  const threadState = getThreadState(store, ctx.thread.id);

  for (const uid of participants) {
    try {
      await fcaChangeNickname(api, nick, ctx.thread.id, uid);
      threadState.nicknames[uid] = nick;
      ok++;
    } catch { failed++; }
    await sleep(800 + Math.random() * 1_200); // jittered 800-2000ms
  }

  let nickBotRestoreOk = true;
  if (botId && botNick) {
    try {
      await fcaChangeNickname(api, botNick, ctx.thread.id, botId);
      pCtx.logger.info("Bot nickname restored after set-nickname.", { threadID: ctx.thread.id, botNick });
    } catch (err) {
      nickBotRestoreOk = false;
      pCtx.logger.warn("Failed to restore bot nickname after set-nickname.", {
        threadID: ctx.thread.id, botNick, error: String(err),
      });
    }
  }

  saveThreadState(store, ctx.thread.id, repo, pCtx.logger);
  pCtx.logger.info("Nicknames set.", { threadID: ctx.thread.id, nick, ok, failed });

  const lines = [HEADER, "", `✅ تم تعيين الكنية: "${nick}"`, `⌯ نجح: ${ok} عضو`];
  if (failed > 0)               lines.push(`⌯ فشل: ${failed} عضو`);
  if (botNick && nickBotRestoreOk)  lines.push(`⌯ اسم البوت محمي: "${botNick}"`);
  if (botNick && !nickBotRestoreOk) lines.push(`⚠️ تعذّر استعادة اسم البوت — أعد تعيينه: بوت ${botNick}`);
  await ctx.reply(lines.join("\n"));
}

// ─── Protection sub-handlers ──────────────────────────────────────────────────

async function handleProtection(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  const target = ctx.getArg(0);

  if (target === "تشغيل") {
    await handleProtectNameEnable(ctx, pCtx, store, repo);
  } else if (target === "اغلاق" || target === "إغلاق") {
    await handleProtectNameDisable(ctx, pCtx, store, repo);
  } else if (target === "اسم") {
    await handleProtectNameToggle(ctx, pCtx, store, repo);
  } else if (target === "كنيات") {
    await handleProtectNicknames(ctx, pCtx, store, repo);
  } else {
    const prefix = prefixStore.get();
    await ctx.reply(
      `${HEADER}\n\n⚠️ حدد نوع الحماية:\n` +
      `⌯ ${prefix}حماية اغلاق — إيقاف حماية الاسم\n` +
      `⌯ ${prefix}حماية تشغيل — إعادة تفعيل حماية الاسم\n` +
      `⌯ ${prefix}حماية كنيات — تفعيل/إيقاف حماية الكنيات`
    );
  }
}

/**
 * /حماية تشغيل — يعيد تفعيل الحماية على الاسم المحمي المحفوظ
 */
async function handleProtectNameEnable(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  const api = getApi(pCtx);
  if (!api) { await ctx.reply("⚠️ خدمة Facebook غير متاحة."); return; }

  const info = await assertGroupAdmin(ctx, api, pCtx);
  if (!info) return;

  const threadState = getThreadState(store, ctx.thread.id);

  if (!threadState.lockedName) {
    threadState.lockedName = info.name;
  }

  if (threadState.protectName) {
    await ctx.reply(`${HEADER}\n\n🔒 الحماية مفعّلة بالفعل.\n⌯ الاسم المحمي: "${threadState.lockedName}"`);
    return;
  }

  threadState.protectName = true;
  saveThreadState(store, ctx.thread.id, repo, pCtx.logger);

  logProtectionEnabled(ctx.thread.id, threadState.lockedName, ctx.user.id);
  pCtx.logger.info("Name protection enabled. [protection-active]", {
    threadID:   ctx.thread.id,
    lockedName: threadState.lockedName,
  });

  await ctx.reply(
    `${HEADER}\n\n🔒 تم تفعيل حماية اسم القروب.\n` +
    `⌯ الاسم المحمي: "${threadState.lockedName}"\n` +
    `⌯ أي تغيير خارجي سيُعاد تلقائياً.`
  );
}

/**
 * /حماية اغلاق — يوقف الحماية فقط بدون تغيير الاسم أو مسح الاسم المحمي
 */
async function handleProtectNameDisable(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  const api = getApi(pCtx);
  if (!api) { await ctx.reply("⚠️ خدمة Facebook غير متاحة."); return; }

  const info = await assertGroupAdmin(ctx, api, pCtx);
  if (!info) return;

  const threadState = getThreadState(store, ctx.thread.id);

  if (!threadState.protectName) {
    await ctx.reply(
      `${HEADER}\n\n🔓 الحماية مُعطَّلة بالفعل.` +
      (threadState.lockedName ? `\n⌯ الاسم المحمي المحفوظ: "${threadState.lockedName}"` : "")
    );
    return;
  }

  threadState.protectName = false;
  saveThreadState(store, ctx.thread.id, repo, pCtx.logger);

  logProtectionDisabled(ctx.thread.id, ctx.user.id);
  pCtx.logger.info("Name protection disabled. [protection-inactive]", { threadID: ctx.thread.id });

  await ctx.reply(
    `${HEADER}\n\n🔓 تم إيقاف حماية اسم القروب.\n` +
    (threadState.lockedName
      ? `⌯ الاسم المحمي المحفوظ: "${threadState.lockedName}"\n⌯ لإعادة التفعيل: /حماية تشغيل`
      : "")
  );
}

/**
 * /حماية اسم — toggle للتوافق مع الإصدارات السابقة
 */
async function handleProtectNameToggle(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  const api = getApi(pCtx);
  if (!api) { await ctx.reply("⚠️ خدمة Facebook غير متاحة."); return; }

  const info = await assertGroupAdmin(ctx, api, pCtx);
  if (!info) return;

  const threadState = getThreadState(store, ctx.thread.id);

  if (!threadState.protectName) {
    threadState.protectName = true;
    threadState.lockedName  = info.name;
    saveThreadState(store, ctx.thread.id, repo, pCtx.logger);
    logProtectionEnabled(ctx.thread.id, info.name, ctx.user.id);
    pCtx.logger.info("Name protection toggled on. [protection-active]", {
      threadID: ctx.thread.id,
      lockedName: info.name,
    });
    await ctx.reply(`${HEADER}\n\n🔒 تم تفعيل حماية اسم القروب.\n⌯ الاسم المحمي: "${info.name}"`);
  } else {
    threadState.protectName = false;
    threadState.lockedName  = "";
    saveThreadState(store, ctx.thread.id, repo, pCtx.logger);
    logProtectionDisabled(ctx.thread.id, ctx.user.id);
    pCtx.logger.info("Name protection toggled off. [protection-inactive]", { threadID: ctx.thread.id });
    await ctx.reply(`${HEADER}\n\n🔓 تم إيقاف حماية اسم القروب.`);
  }
}

async function handleProtectNicknames(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  const api = getApi(pCtx);
  if (!api) { await ctx.reply("⚠️ خدمة Facebook غير متاحة."); return; }

  const info = await assertGroupAdmin(ctx, api, pCtx);
  if (!info) return;

  const threadState = getThreadState(store, ctx.thread.id);

  if (!threadState.protectNicknames) {
    if (Object.keys(threadState.nicknames).length === 0) {
      await ctx.reply("⚠️ لا توجد كنيات محفوظة لهذا القروب.\nاستخدم أولاً: /كنية [كنية]");
      return;
    }
    threadState.protectNicknames = true;
    saveThreadState(store, ctx.thread.id, repo, pCtx.logger);
    pCtx.logger.info("Nickname protection enabled.", { threadID: ctx.thread.id });
    await ctx.reply(
      `${HEADER}\n\n🔒 تم تفعيل حماية الكنيات.\n` +
      `⌯ عدد الأعضاء المحميين: ${Object.keys(threadState.nicknames).length}`
    );
  } else {
    threadState.protectNicknames = false;
    saveThreadState(store, ctx.thread.id, repo, pCtx.logger);
    pCtx.logger.info("Nickname protection disabled.", { threadID: ctx.thread.id });
    await ctx.reply(`${HEADER}\n\n🔓 تم إيقاف حماية الكنيات.`);
  }
}

async function handleClearNicknames(
  ctx:   Context,
  pCtx:  IPluginContext,
  store: ProtectionStore,
  repo:  IGroupSettingsRepository | null,
): Promise<void> {
  await ctx.typingOn();
  const target = ctx.getArg(0);
  if (target !== "كنيات") {
    await ctx.reply("⚠️ هل تقصد: /تنظيف كنيات");
    return;
  }

  const api = getApi(pCtx);
  if (!api) { await ctx.reply("⚠️ خدمة Facebook غير متاحة."); return; }

  const info = await assertGroupAdmin(ctx, api, pCtx);
  if (!info) return;

  const botId   = api.getCurrentUserID();
  const botNick = store.botNicknames[ctx.thread.id] ?? null;
  const participants = info.participantIDs.filter((id) => id !== botId);

  await ctx.reply(`⏳ جارٍ مسح الكنيات لـ ${participants.length} عضو...`);

  let ok = 0, failed = 0;

  for (const uid of participants) {
    try {
      await fcaChangeNickname(api, "", ctx.thread.id, uid);
      ok++;
    } catch { failed++; }
    await sleep(800 + Math.random() * 1_200); // jittered 800-2000ms
  }

  let clearBotRestoreOk = true;
  if (botId && botNick) {
    try {
      await fcaChangeNickname(api, botNick, ctx.thread.id, botId);
      pCtx.logger.info("Bot nickname restored after clear-nicknames.", { threadID: ctx.thread.id, botNick });
    } catch (err) {
      clearBotRestoreOk = false;
      pCtx.logger.warn("Failed to restore bot nickname after clear-nicknames.", {
        threadID: ctx.thread.id, botNick, error: String(err),
      });
    }
  }

  const threadState = getThreadState(store, ctx.thread.id);
  threadState.nicknames        = {};
  threadState.protectNicknames = false;
  saveThreadState(store, ctx.thread.id, repo, pCtx.logger);

  pCtx.logger.info("All nicknames cleared.", { threadID: ctx.thread.id, ok, failed });

  const lines = [HEADER, "", "✅ تم مسح جميع الكنيات", `⌯ نجح: ${ok} عضو`];
  if (failed > 0)               lines.push(`⌯ فشل: ${failed} عضو`);
  if (botNick && clearBotRestoreOk)  lines.push(`⌯ اسم البوت محمي: "${botNick}"`);
  if (botNick && !clearBotRestoreOk) lines.push(`⚠️ تعذّر استعادة اسم البوت — أعد تعيينه: بوت ${botNick}`);
  await ctx.reply(lines.join("\n"));
}

// ─── Plugin class ─────────────────────────────────────────────────────────────

/** Interval for the self-healing watchdog (every 5 minutes). */
const WATCHDOG_INTERVAL_MS = 5 * 60_000;

class ManagementPlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name:        "management",
    version:     "8.0.0",
    description: "إدارة أسماء القروب — حماية تلقائية. Self-healing watchdog. MongoDB مع retry.",
    author:      "Sixseven-6677",
  };

  private ctx!:              IPluginContext;
  private store:             ProtectionStore = { threads: {}, botNicknames: {} };
  private repo:              IGroupSettingsRepository | null = null;
  private watchdogTimer:     ReturnType<typeof setInterval> | null = null;
  private lastConnectedState = false;

  // ─── onLoad: load protection state from MongoDB (with retry) ──────────────

  async onLoad(ctx: IPluginContext): Promise<void> {
    this.ctx  = ctx;
    this.repo = ctx.consumeService<IGroupSettingsRepository>("group-settings-repo") ?? null;

    if (this.repo) {
      const loaded = await loadFromMongoWithRetry(this.repo, ctx.logger);
      if (loaded) {
        this.store = loaded;
      } else {
        // MongoDB failed after all retries — start with empty protection state
        this.store = { threads: {}, botNicknames: {} };
        ctx.logger.warn(
          "ManagementPlugin: MongoDB unavailable after retries — starting with empty state.",
          { savedThreads: 0 },
        );
      }
    } else {
      this.store = { threads: {}, botNicknames: {} };
      ctx.logger.warn(
        "ManagementPlugin: no MongoDB repo — starting with empty protection state.",
        { savedThreads: 0 },
      );
    }
  }

  // ─── onEnable: register commands + start self-healing watchdog ────────────

  async onEnable(): Promise<void> {
    const pCtx  = this.ctx;
    const store = this.store;
    const repo  = this.repo;

    const cmdName: ICommand = {
      name: "اسم", aliases: ["name", "groupname"],
      description: "تغيير اسم القروب مع تفعيل الحماية تلقائياً", usage: "اسم [الاسم الجديد]",
      category: "util", adminOnly: false, hidden: true,
      async execute(ctx) { await handleGroupName(ctx, pCtx, store, repo); },
    };

    const cmdBot: ICommand = {
      name: "بوت", aliases: ["botnick", "botname"],
      description: "تغيير اسم البوت في القروب", usage: "بوت [الاسم]",
      category: "util", adminOnly: false, hidden: true,
      async execute(ctx) { await handleBotName(ctx, pCtx, store, repo); },
    };

    const cmdNick: ICommand = {
      name: "كنية", aliases: ["nick", "nickname"],
      description: "تعيين كنية لجميع الأعضاء", usage: "كنية [الكنية]",
      category: "util", adminOnly: false, hidden: true,
      async execute(ctx) { await handleSetNickname(ctx, pCtx, store, repo); },
    };

    const cmdProtect: ICommand = {
      name: "حماية", aliases: ["protect", "protection"],
      description: "تشغيل/إيقاف حماية الاسم أو الكنيات", usage: "حماية [تشغيل|اغلاق|كنيات]",
      category: "util", adminOnly: false, hidden: true,
      async execute(ctx) { await handleProtection(ctx, pCtx, store, repo); },
    };

    const cmdClean: ICommand = {
      name: "تنظيف", aliases: ["clean", "clearnicks"],
      description: "مسح جميع الكنيات من القروب", usage: "تنظيف كنيات",
      category: "util", adminOnly: false, hidden: true,
      async execute(ctx) { await handleClearNicknames(ctx, pCtx, store, repo); },
    };

    const cmdHelp: ICommand = {
      name: "ادارة", aliases: ["manage", "إدارة", "management"],
      description: "عرض أوامر إدارة القروب", usage: "ادارة",
      category: "admin", adminOnly: false, hidden: false,
      async execute(ctx) { await showHelp(ctx); },
    };

    for (const cmd of [cmdName, cmdBot, cmdNick, cmdProtect, cmdClean, cmdHelp]) {
      pCtx.registerCommand(cmd);
      pCtx.logger.info(`Command "${cmd.name}" registered (aliases: ${cmd.aliases?.join(", ")}).`);
    }

    // ── Self-healing watchdog ──────────────────────────────────────────────
    // Runs every 5 minutes and:
    //   1. Logs the current protection summary so issues are visible in logs.
    //   2. Detects transport reconnect (was disconnected, now connected) and
    //      re-syncs the protection store from MongoDB to ensure state is current.
    //   3. Detects permanent transport failure and warns loudly.
    this.startWatchdog(pCtx);

    pCtx.logger.info(
      "ManagementPlugin v8 enabled. [watchdog-start] " +
      `Storage: ${this.repo ? "MongoDB" : "file"}. ` +
      `Watchdog interval: ${WATCHDOG_INTERVAL_MS / 1000}s.`,
    );
  }

  // ─── Watchdog ──────────────────────────────────────────────────────────────

  private startWatchdog(pCtx: IPluginContext): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);

    this.watchdogTimer = setInterval(() => {
      this.watchdogTick(pCtx).catch((err: unknown) => {
        pCtx.logger.warn("ManagementPlugin: watchdog tick threw.", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, WATCHDOG_INTERVAL_MS);
  }

  private async watchdogTick(pCtx: IPluginContext): Promise<void> {
    const transport = pCtx.consumeService<IMiraiService>("mirai-transport");
    const isConnected = transport?.isConnected() ?? false;

    const summary = getProtectionSummary();

    // ── Always log protection status ──────────────────────────────────────
    pCtx.logger.info("ManagementPlugin: watchdog tick. [watchdog-tick]", {
      transport:      isConnected ? "connected" : "disconnected",
      protectedNames: summary.protectedNames,
      protectedNicks: summary.protectedNicks,
      totalThreads:   summary.totalThreads,
      activeThreads:  summary.threads
        .filter(t => t.protectName)
        .map(t => ({
          threadId:    t.threadId,
          lockedName:  t.lockedName,
          revertCount: t.revertCount,
          enabledAt:   t.enabledAt,
          lastRevertAt: t.lastRevertAt,
          lastEventAt:  t.lastEventAt,
        })),
      timestamp: new Date().toISOString(),
    });

    // ── Detect reconnect: transport was down, now it's back ───────────────
    if (!this.lastConnectedState && isConnected) {
      pCtx.logger.info(
        "ManagementPlugin: transport just reconnected — reloading protection state from MongoDB. [self-healing]",
      );
      await this.reloadFromMongo(pCtx);
    }

    // ── Warn if transport is down ─────────────────────────────────────────
    if (!isConnected) {
      pCtx.logger.warn(
        "ManagementPlugin: transport is DISCONNECTED — name protection INACTIVE. [protection-warning]",
        {
          protectedNames: summary.protectedNames,
          note: "Protection will resume automatically once transport reconnects.",
          timestamp: new Date().toISOString(),
        },
      );
    }

    this.lastConnectedState = isConnected;
  }

  /** Reload protection state from MongoDB (called on reconnect). */
  private async reloadFromMongo(pCtx: IPluginContext): Promise<void> {
    if (!this.repo) {
      pCtx.logger.info("ManagementPlugin: reloadFromMongo skipped — no repo available.");
      return;
    }

    const loaded = await loadFromMongoWithRetry(this.repo, pCtx.logger, 2, 1_000);
    if (loaded) {
      this.store = loaded;
      setProtectionStore(this.store);
      const summary = getProtectionSummary();
      pCtx.logger.info(
        "ManagementPlugin: protection state reloaded from MongoDB after reconnect. [protection-reloaded]",
        {
          protectedNames: summary.protectedNames,
          totalThreads:   summary.totalThreads,
          timestamp:      new Date().toISOString(),
        },
      );
    } else {
      pCtx.logger.warn("ManagementPlugin: reloadFromMongo failed — keeping existing in-memory state.");
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onDisable(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      this.ctx.logger.info("ManagementPlugin: watchdog stopped. [watchdog-stop]");
    }
    this.ctx.logger.info("ManagementPlugin disabled.");
  }

  async onUnload(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.ctx.logger.info("ManagementPlugin unloaded.");
  }
}

export default new ManagementPlugin();
