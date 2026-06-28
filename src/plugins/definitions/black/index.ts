import fs   from "fs";
import path from "path";
import { IPlugin, PluginManifest }        from "../../types/IPlugin";
import { IPluginContext, IDisposable }    from "../../types/IPluginContext";
import { ICommand }                       from "../../../commands/types/ICommand";
import { Context }                        from "../../../context/Context";

// ─── Local interface for sender service ──────────────────────────────────────

interface ISenderService {
  sendText(recipientId: string, text: string): Promise<void>;
}

interface ITransportStatus {
  isConnected(): boolean;
}

// ─── Repository interface (loose coupling) ───────────────────────────────────

interface IBlackConfigRepository {
  findAll(): Promise<Array<{
    threadId:    string;
    message:     string;
    intervalSec: number;
    active:      boolean;
    lastSentAt:  Date | null;
  }>>;
  upsert(threadId: string, data: Partial<{
    message:     string;
    intervalSec: number;
    active:      boolean;
    lastSentAt:  Date | null;
  }>): Promise<void>;
}

// ─── Persistent store ─────────────────────────────────────────────────────────

interface ThreadConfig {
  message:     string;
  intervalSec: number;
  active:      boolean;
  lastSentAt:  string | null;
}

interface StoreData {
  threads: Record<string, ThreadConfig>;
}

const DATA_PATH = path.resolve("data/black-plugin.json");

function loadStore(): StoreData {
  try {
    if (fs.existsSync(DATA_PATH)) {
      return JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as StoreData;
    }
  } catch {
    // Corrupt or missing file — start fresh
  }
  return { threads: {} };
}

function saveStoreFile(data: StoreData): void {
  try {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch { /* best effort */ }
}

function getThread(store: StoreData, threadId: string): ThreadConfig {
  if (!store.threads[threadId]) {
    store.threads[threadId] = {
      message:     "",
      intervalSec: 0,
      active:      false,
      lastSentAt:  null,
    };
  }
  return store.threads[threadId]!;
}

// ─── Raw-text helper ──────────────────────────────────────────────────────────

/**
 * Extracts the body of a command message while preserving ALL internal
 * whitespace (multi-spaces, tabs, newlines).
 *
 * ctx.args is tokenised on /\s+/, so ctx.args.slice(n).join(" ") destroys
 * every extra space and every newline the user typed.
 *
 * This function works directly on the raw message string: strips exactly
 * `n` leading whitespace-delimited tokens (command name + subcommand words),
 * then removes only the single separator between the last token and the body —
 * leaving all internal whitespace completely intact.
 *
 * @param rawText   The full raw message text (ctx.message.text).
 * @param n         Number of leading tokens to strip (commandName + subcommand = 2).
 */
function rawBodyAfterArgs(rawText: string, n: number): string {
  let s = rawText;
  for (let i = 0; i < n; i++) {
    s = s.replace(/^\s*\S+/, "");
  }
  return s.replace(/^[ \t]+/, "");
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HEADER = "⸪⟅𝐕̶݈̂͜𝔈̟͢⃟݃།̶𝝬̶۪͛ۡ⸸𝚬̱̩⩨ܵ𝐁᮫͎ܺ݀ࣸ᷼᷍⃢ː𝚶̶݄݈݊𝐓݂ ❈ 🦢";

/**
 * Minimum allowed interval in seconds.
 *
 * WHY 60s: Facebook's anti-bot systems detect rapid automated messaging
 * (< 60s intervals) and flag the session, leading to checkpoints and
 * AppState expiry. Enforcing this floor prevents the most common cause
 * of session death on hosted bots.
 */
const MIN_INTERVAL_SEC = 60;

/**
 * Below this threshold (5 min) the send rate is high enough to attract
 * Facebook attention. We allow it but show a risk warning.
 */
const WARN_INTERVAL_SEC = 300;

// ─── Plugin ───────────────────────────────────────────────────────────────────

class BlackPlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name:        "black",
    version:     "2.2.0",
    description: "إرسال رسالة تلقائية متكررة داخل القروب بفاصل زمني يحدده الأدمن. يحفظ في MongoDB.",
    author:      "Sixseven-6677",
  };

  private ctx!:         IPluginContext;
  private store:        StoreData                    = { threads: {} };
  private activeTimers: Map<string, IDisposable>     = new Map();
  private repo:         IBlackConfigRepository | null = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onLoad(ctx: IPluginContext): Promise<void> {
    this.ctx  = ctx;
    this.repo = ctx.consumeService<IBlackConfigRepository>("black-config-repo") ?? null;

    if (this.repo) {
      try {
        const docs = await this.repo.findAll();
        for (const doc of docs) {
          this.store.threads[doc.threadId] = {
            message:     doc.message,
            intervalSec: doc.intervalSec,
            active:      doc.active,
            lastSentAt:  doc.lastSentAt ? doc.lastSentAt.toISOString() : null,
          };
        }
        ctx.logger.info("BlackPlugin: loaded from MongoDB.", {
          threads: docs.length,
        });
      } catch (err) {
        ctx.logger.warn("BlackPlugin: MongoDB load failed — falling back to file.", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.store = loadStore();
      }
    } else {
      this.store = loadStore();
      ctx.logger.info("BlackPlugin: loaded from file.", {
        threads: Object.keys(this.store.threads).length,
      });
    }
  }

  async onEnable(): Promise<void> {
    const pCtx = this.ctx;

    pCtx.registerCommand(this.buildCommand(pCtx));
    pCtx.logger.info("Command \"بلاك\" registered (aliases: black, blk). Category: automation.");

    for (const [threadId, config] of Object.entries(this.store.threads)) {
      if (config.active && config.message && config.intervalSec > 0) {
        this.startTimer(pCtx, threadId);
        pCtx.logger.info("Black: restored active timer.", {
          threadId,
          intervalSec: config.intervalSec,
        });
      }
    }
  }

  async onDisable(): Promise<void> {
    for (const [threadId, disposable] of this.activeTimers) {
      disposable.dispose();
      this.ctx.logger.debug("Black: timer stopped on disable.", { threadId });
    }
    this.activeTimers.clear();
    await this.saveAll("onDisable");
    this.ctx.logger.info("BlackPlugin disabled.");
  }

  async onUnload(): Promise<void> {
    await this.saveAll("onUnload");
    this.ctx.logger.info("BlackPlugin unloaded.");
  }

  // ── Persistence helpers ───────────────────────────────────────────────────

  private saveThread(threadId: string): void {
    const cfg = this.store.threads[threadId];
    if (!cfg) return;

    if (this.repo) {
      this.repo.upsert(threadId, {
        message:     cfg.message,
        intervalSec: cfg.intervalSec,
        active:      cfg.active,
        lastSentAt:  cfg.lastSentAt ? new Date(cfg.lastSentAt) : null,
      }).catch((err: unknown) => {
        this.ctx.logger.warn("BlackPlugin: MongoDB thread save failed.", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        saveStoreFile(this.store);
      });
    } else {
      saveStoreFile(this.store);
    }
  }

  private async saveAll(caller: string): Promise<void> {
    if (this.repo) {
      const promises = Object.keys(this.store.threads).map((threadId) =>
        this.repo!.upsert(threadId, {
          ...this.store.threads[threadId]!,
          lastSentAt: this.store.threads[threadId]!.lastSentAt
            ? new Date(this.store.threads[threadId]!.lastSentAt)
            : null,
        }).catch((err: unknown) => {
          this.ctx.logger.warn(`BlackPlugin.${caller}: MongoDB save failed for thread.`, {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
      );
      await Promise.allSettled(promises);
    } else {
      saveStoreFile(this.store);
    }
  }

  // ── Timer helpers ─────────────────────────────────────────────────────────

  private startTimer(pCtx: IPluginContext, threadId: string): void {
    if (this.activeTimers.has(threadId)) return;

    const store  = this.store;
    const plugin = this;

    const disposable = pCtx.scheduleRecurring({
      name:           `black:${threadId}`,
      intervalMs:     (store.threads[threadId]?.intervalSec ?? 60) * 1_000,
      runImmediately: false,
      fn: async () => {
        const cfg = store.threads[threadId];
        if (!cfg?.active || !cfg.message) return;

        // ── Connectivity guard: skip tick immediately if Facebook is offline ──
        //
        // Without this check, the sender waits up to 20s per failed attempt,
        // and with 4 retry attempts that is 80s of blocking per timer tick.
        // During a disconnection this creates a thundering-herd of waiting
        // promises that stall the event loop and log noise.
        //
        // mirai-transport.isConnected() returns true only when the MQTT API
        // object exists — false during login, checkpoint, or circuit-open.
        // If disconnected, skip this tick silently; the next tick will retry.
        const transport = pCtx.consumeService<ITransportStatus>("mirai-transport");
        if (transport && !transport.isConnected()) {
          pCtx.logger.debug("Black: Facebook disconnected — skipping tick.", { threadId });
          return;
        }

        const sender = pCtx.consumeService<ISenderService>("facebook-sender");
        if (!sender) {
          pCtx.logger.warn("Black: facebook-sender service unavailable.", { threadId });
          return;
        }

        try {
          await sender.sendText(threadId, cfg.message);
          cfg.lastSentAt = new Date().toISOString();
          if (plugin.repo) {
            plugin.repo.upsert(threadId, { lastSentAt: new Date() }).catch((err: unknown) => {
              pCtx.logger.warn("Black: MongoDB lastSentAt update failed.", {
                threadId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          } else {
            saveStoreFile(store);
          }
          pCtx.logger.debug("Black: message sent.", { threadId });
        } catch (err) {
          pCtx.logger.warn("Black: failed to send message.", {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      onError: (err) => {
        pCtx.logger.warn("Black: recurring task error.", {
          threadId,
          error: err instanceof Error ? (err as Error).message : String(err),
        });
      },
    });

    this.activeTimers.set(threadId, disposable);
  }

  private stopTimer(threadId: string): boolean {
    const disposable = this.activeTimers.get(threadId);
    if (!disposable) return false;
    disposable.dispose();
    this.activeTimers.delete(threadId);
    return true;
  }

  // ── Command builder ───────────────────────────────────────────────────────

  private buildCommand(pCtx: IPluginContext): ICommand {
    const plugin = this;

    return {
      name:        "بلاك",
      aliases:     ["black", "blk"],
      description: "إرسال رسالة تلقائية متكررة داخل القروب",
      usage:       "بلاك [تشغيل|ايقاف|رسالة <نص>|وقت <ثواني>|حالة]",
      category:    "private",
      adminOnly:   true,
      hidden:      false,

      async execute(ctx: Context): Promise<void> {
        const sub = ctx.getArg(0);

        switch (sub) {
          case "تشغيل":
          case "on":
            await plugin.handleEnable(ctx, pCtx);
            break;

          case "ايقاف":
          case "إيقاف":
          case "off":
            await plugin.handleDisable(ctx, pCtx);
            break;

          case "رسالة":
          case "msg":
          case "message":
            await plugin.handleSetMessage(ctx, pCtx);
            break;

          case "وقت":
          case "time":
          case "interval":
            await plugin.handleSetInterval(ctx, pCtx);
            break;

          case "حالة":
          case "status":
            await plugin.handleStatus(ctx);
            break;

          default:
            await plugin.showHelp(ctx);
        }
      },
    };
  }

  // ── Sub-handlers ──────────────────────────────────────────────────────────

  private async handleEnable(ctx: Context, pCtx: IPluginContext): Promise<void> {
    await ctx.typingOn();

    const config = getThread(this.store, ctx.thread.id);

    if (!config.message) {
      await ctx.reply([
        HEADER,
        "",
        "⚠️ لم يتم تحديد الرسالة بعد.",
        "استخدم أولاً: بلاك رسالة <النص>",
      ].join("\n"));
      return;
    }

    if (config.intervalSec <= 0) {
      await ctx.reply([
        HEADER,
        "",
        "⚠️ لم يتم تحديد الوقت بعد.",
        "استخدم أولاً: بلاك وقت <الثواني>",
      ].join("\n"));
      return;
    }

    if (config.active && this.activeTimers.has(ctx.thread.id)) {
      await ctx.reply([
        HEADER,
        "",
        "ℹ️ النظام مفعّل بالفعل في هذا القروب.",
        `⌯ الرسالة: ${config.message.slice(0, 60)}${config.message.length > 60 ? "…" : ""}`,
        `⌯ كل: ${config.intervalSec} ثانية`,
      ].join("\n"));
      return;
    }

    config.active = true;
    this.saveThread(ctx.thread.id);
    this.startTimer(pCtx, ctx.thread.id);

    pCtx.logger.info("Black: enabled.", {
      threadId:    ctx.thread.id,
      by:          ctx.user.id,
      intervalSec: config.intervalSec,
    });

    await ctx.reply([
      HEADER,
      "",
      "✅ تم تفعيل نظام الإرسال التلقائي.",
      `⌯ الرسالة: ${config.message.slice(0, 60)}${config.message.length > 60 ? "…" : ""}`,
      `⌯ كل: ${config.intervalSec} ثانية`,
    ].join("\n"));
  }

  private async handleDisable(ctx: Context, pCtx: IPluginContext): Promise<void> {
    await ctx.typingOn();

    const config = getThread(this.store, ctx.thread.id);

    if (!config.active && !this.activeTimers.has(ctx.thread.id)) {
      await ctx.reply(`${HEADER}\n\nℹ️ النظام غير مفعّل في هذا القروب.`);
      return;
    }

    config.active = false;
    this.saveThread(ctx.thread.id);
    this.stopTimer(ctx.thread.id);

    pCtx.logger.info("Black: disabled.", {
      threadId: ctx.thread.id,
      by:       ctx.user.id,
    });

    await ctx.reply([
      HEADER,
      "",
      "🛑 تم إيقاف الإرسال التلقائي.",
    ].join("\n"));
  }

  private async handleSetMessage(ctx: Context, pCtx: IPluginContext): Promise<void> {
    await ctx.typingOn();

    const newMessage = rawBodyAfterArgs(ctx.message.text ?? "", 2);

    if (!newMessage) {
      await ctx.reply([
        HEADER,
        "",
        "⚠️ الرجاء إدخال نص الرسالة.",
        "مثال: بلاك رسالة مرحباً بالجميع!",
      ].join("\n"));
      return;
    }

    const config     = getThread(this.store, ctx.thread.id);
    const wasRunning = config.active && this.activeTimers.has(ctx.thread.id);

    config.message = newMessage;
    this.saveThread(ctx.thread.id);

    pCtx.logger.info("Black: message updated.", {
      threadId: ctx.thread.id,
      by:       ctx.user.id,
      message:  newMessage.slice(0, 80),
    });

    const statusLine = wasRunning
      ? "⌯ التغيير سيُطبَّق في الدورة القادمة."
      : "⌯ ستحتاج تشغيل: بلاك تشغيل";

    await ctx.reply([
      HEADER,
      "",
      "✅ تم تحديث الرسالة.",
      `⌯ الرسالة الجديدة: ${newMessage.slice(0, 100)}${newMessage.length > 100 ? "…" : ""}`,
      statusLine,
    ].join("\n"));
  }

  private async handleSetInterval(ctx: Context, pCtx: IPluginContext): Promise<void> {
    await ctx.typingOn();

    const raw     = ctx.getArg(1);
    const seconds = parseInt(raw ?? "", 10);

    if (!raw || isNaN(seconds) || seconds <= 0) {
      await ctx.reply([
        HEADER,
        "",
        "⚠️ الرجاء إدخال عدد ثواني صحيح أكبر من 0.",
        "مثال: بلاك وقت 60",
      ].join("\n"));
      return;
    }

    // ── Minimum interval enforcement ─────────────────────────────────────────
    //
    // Facebook's bot-detection flags sessions that send automated messages
    // faster than ~1/min. Intervals below MIN_INTERVAL_SEC consistently
    // trigger checkpoints and AppState invalidation within hours of operation.
    //
    // This is the primary cause of the "AppState dies after a few hours" pattern.
    if (seconds < MIN_INTERVAL_SEC) {
      await ctx.reply([
        HEADER,
        "",
        `⛔ الحد الأدنى للفاصل الزمني هو ${MIN_INTERVAL_SEC} ثانية.`,
        "",
        "⚠️ السبب: فيسبوك يكتشف الإرسال السريع كسلوك بوت",
        "   ويحجب الجلسة ويطلب تحقق هوية (checkpoint).",
        "",
        `⌯ استخدم قيمة ≥ ${MIN_INTERVAL_SEC} ثانية — يُنصح بـ 300 ثانية فأكثر.`,
      ].join("\n"));
      return;
    }

    const config     = getThread(this.store, ctx.thread.id);
    const wasRunning = config.active && this.activeTimers.has(ctx.thread.id);

    config.intervalSec = seconds;
    this.saveThread(ctx.thread.id);

    if (wasRunning) {
      this.stopTimer(ctx.thread.id);
      this.startTimer(pCtx, ctx.thread.id);
    }

    pCtx.logger.info("Black: interval updated.", {
      threadId:    ctx.thread.id,
      by:          ctx.user.id,
      intervalSec: seconds,
      restarted:   wasRunning,
    });

    const statusLine = wasRunning
      ? "⌯ تم تطبيق التغيير فوراً — المؤقت أُعيد تشغيله."
      : "⌯ ستحتاج تشغيل: بلاك تشغيل";

    // Warn if interval is low but above the minimum
    const riskWarning = seconds < WARN_INTERVAL_SEC
      ? `\n⚠️ تحذير: ${seconds} ثانية قريب من حد الكشف. يُنصح بـ 300 ثانية+.`
      : "";

    await ctx.reply([
      HEADER,
      "",
      `✅ تم تحديث فترة الإرسال إلى: ${seconds} ثانية`,
      statusLine,
      riskWarning,
    ].join("\n"));
  }

  private async handleStatus(ctx: Context): Promise<void> {
    await ctx.typingOn();

    const config = this.store.threads[ctx.thread.id];

    if (!config) {
      await ctx.reply([
        HEADER,
        "",
        "⌯ لا توجد إعدادات لهذا القروب بعد.",
        "ابدأ بـ: بلاك رسالة <النص> ثم بلاك وقت <الثواني>",
      ].join("\n"));
      return;
    }

    const running     = this.activeTimers.has(ctx.thread.id);
    const statusEmoji = running ? "🟢 مفعّل" : "🔴 غير مفعّل";

    const msgPreview = config.message
      ? config.message.slice(0, 80) + (config.message.length > 80 ? "…" : "")
      : "لم تُحدَّد بعد";

    const intervalStr = config.intervalSec > 0
      ? `${config.intervalSec} ثانية${config.intervalSec < WARN_INTERVAL_SEC ? " ⚠️" : ""}`
      : "لم يُحدَّد بعد";

    const lastSent = config.lastSentAt
      ? new Date(config.lastSentAt).toLocaleString("ar-SA")
      : "لم يُرسَل بعد";

    const storage = this.repo ? "MongoDB ✓" : "ملف محلي";

    await ctx.reply([
      HEADER,
      "",
      `⌯ الحالة:        ${statusEmoji}`,
      `⌯ الرسالة:       ${msgPreview}`,
      `⌯ الفاصل:        ${intervalStr}`,
      `⌯ آخر إرسال:     ${lastSent}`,
      `⌯ التخزين:       ${storage}`,
    ].join("\n"));
  }

  private async showHelp(ctx: Context): Promise<void> {
    await ctx.reply([
      HEADER,
      "",
      "⌯ أوامر الإرسال التلقائي (للأدمن فقط):",
      "",
      "• بلاك رسالة <النص>",
      "  ↳ تحديد الرسالة التي ستُرسَل تلقائياً",
      "",
      `• بلاك وقت <الثواني>  (الحد الأدنى: ${MIN_INTERVAL_SEC}ث)`,
      "  ↳ تحديد فترة الإرسال بالثواني",
      "",
      "• بلاك تشغيل",
      "  ↳ تفعيل الإرسال التلقائي",
      "",
      "• بلاك ايقاف",
      "  ↳ إيقاف الإرسال التلقائي",
      "",
      "• بلاك حالة",
      "  ↳ عرض الإعدادات الحالية والحالة",
    ].join("\n"));
  }
}

export default new BlackPlugin();
