import { ILogger }              from "../../../../logger/types/ILogger";
import { BanStore }             from "../../../../middleware/built-in/banned.middleware";
import { ModerationRepository } from "../db/ModerationRepository";
import {
  IModerationService,
  ModerationResult,
  ModerationRecord,
  BanOptions,
  MuteOptions,
  toRecord,
} from "./IModerationService";

const MUTE_PREFIX = "[MUTED]";
const KICK_PREFIX = "[KICKED]";

export interface ModerationServiceConfig {
  maxWarnings:       number;
  autoBanDurationMs: number;
  kickDurationMs:    number;
}

const DEFAULTS: ModerationServiceConfig = {
  maxWarnings:       3,
  autoBanDurationMs: 0,
  kickDurationMs:    30 * 60_000,
};

export class ModerationService implements IModerationService {
  private readonly cfg: ModerationServiceConfig;

  constructor(
    private readonly repo:     ModerationRepository,
    private readonly banStore: BanStore,
    private readonly log:      ILogger,
    cfg: Partial<ModerationServiceConfig> = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  async ban(targetId: string, actorId: string, opts: BanOptions = {}): Promise<ModerationResult> {
    if (this.banStore.isBanned(targetId)) {
      return this.r(false, "ban", targetId, "المستخدم محظور بالفعل.");
    }
    const { reason, durationMs } = opts;
    const expiresAt = durationMs ? new Date(Date.now() + durationMs) : undefined;

    await this.repo.create({ targetId, actorId, action: "ban", reason, durationMs, expiresAt, active: true });
    this.banStore.ban(targetId, { reason, durationMs, bannedBy: actorId });

    this.log.info("Moderation: ban applied.", { targetId, actorId, reason, durationMs });
    const durStr = durationMs ? `لمدة ${this.fmt(durationMs)}` : "دائماً";
    return this.r(true, "ban", targetId, `تم الحظر (${durStr}).`);
  }

  async unban(targetId: string, actorId: string): Promise<ModerationResult> {
    const wasBanned = this.banStore.isBanned(targetId);
    const hadRecord = await this.repo.hasActiveRecord(targetId, "ban");

    if (!wasBanned && !hadRecord) {
      return this.r(false, "unban", targetId, "المستخدم غير محظور.");
    }

    await this.repo.deactivateRecords(targetId, "ban");
    await this.repo.create({ targetId, actorId, action: "unban", active: false });
    this.banStore.unban(targetId);

    this.log.info("Moderation: ban lifted.", { targetId, actorId });
    return this.r(true, "unban", targetId, "تم رفع الحظر.");
  }

  async warn(targetId: string, actorId: string, reason?: string): Promise<ModerationResult> {
    await this.repo.create({ targetId, actorId, action: "warn", reason, active: true });
    const warnCount = await this.repo.countActiveWarnings(targetId);

    this.log.info("Moderation: warning issued.", { targetId, actorId, reason, warnCount });

    if (warnCount >= this.cfg.maxWarnings) {
      const autoBanReason = `تجاوز الحد الأقصى للتحذيرات (${warnCount}/${this.cfg.maxWarnings})`;
      await this.ban(targetId, actorId, {
        reason:     autoBanReason,
        durationMs: this.cfg.autoBanDurationMs || undefined,
      });
      this.log.warn("Moderation: auto-ban triggered.", { targetId, warnCount });
      return { ...this.r(true, "warn", targetId, `تحذير ${warnCount}/${this.cfg.maxWarnings} — تم الحظر تلقائياً.`), warnCount, autoBanned: true };
    }

    return { ...this.r(true, "warn", targetId, `تحذير ${warnCount}/${this.cfg.maxWarnings}.`), warnCount };
  }

  async mute(targetId: string, actorId: string, opts: MuteOptions = {}): Promise<ModerationResult> {
    if (this.banStore.isBanned(targetId)) {
      const entry = this.banStore.getEntry(targetId);
      if (entry?.reason?.startsWith(MUTE_PREFIX)) {
        return this.r(false, "mute", targetId, "المستخدم مكتوم بالفعل.");
      }
      return this.r(false, "mute", targetId, "المستخدم محظور — قم برفع الحظر أولاً.");
    }

    const { reason, durationMs } = opts;
    const expiresAt  = durationMs ? new Date(Date.now() + durationMs) : undefined;
    const muteReason = `${MUTE_PREFIX} ${reason ?? ""}`.trim();

    await this.repo.create({ targetId, actorId, action: "mute", reason, durationMs, expiresAt, active: true });
    this.banStore.ban(targetId, { reason: muteReason, durationMs, bannedBy: actorId });

    this.log.info("Moderation: user muted.", { targetId, actorId, durationMs });
    const durStr = durationMs ? `لمدة ${this.fmt(durationMs)}` : "دائماً";
    return this.r(true, "mute", targetId, `تم الكتم (${durStr}).`);
  }

  async unmute(targetId: string, actorId: string): Promise<ModerationResult> {
    const entry     = this.banStore.getEntry(targetId);
    const isMuted   = entry?.reason?.startsWith(MUTE_PREFIX) ?? false;
    const hadRecord = await this.repo.hasActiveRecord(targetId, "mute");

    if (!isMuted && !hadRecord) {
      return this.r(false, "unmute", targetId, "المستخدم غير مكتوم.");
    }

    await this.repo.deactivateRecords(targetId, "mute");
    await this.repo.create({ targetId, actorId, action: "unmute", active: false });
    this.banStore.unban(targetId);

    this.log.info("Moderation: mute lifted.", { targetId, actorId });
    return this.r(true, "unmute", targetId, "تم رفع الكتم.");
  }

  async kick(targetId: string, actorId: string, reason?: string): Promise<ModerationResult> {
    const durationMs = this.cfg.kickDurationMs;
    const expiresAt  = new Date(Date.now() + durationMs);
    const kickReason = `${KICK_PREFIX} ${reason ?? ""}`.trim();

    await this.repo.create({ targetId, actorId, action: "kick", reason, durationMs, expiresAt, active: true });
    this.banStore.ban(targetId, { reason: kickReason, durationMs, bannedBy: actorId });

    this.log.info("Moderation: user kicked.", { targetId, actorId, reason, durationMs });
    return this.r(true, "kick", targetId, `تم الطرد لمدة ${this.fmt(durationMs)}.`);
  }

  async getHistory(targetId: string, limit = 20): Promise<ModerationRecord[]> {
    const docs = await this.repo.getHistory(targetId, limit);
    return docs.map(toRecord);
  }

  async isActive(targetId: string, action: string): Promise<boolean> {
    if (action === "ban" || action === "mute") return this.banStore.isBanned(targetId);
    return this.repo.hasActiveRecord(targetId, action as never);
  }

  private r(ok: boolean, action: string, targetId: string, message: string): ModerationResult {
    return { ok, action, targetId, message };
  }

  private fmt(ms: number): string {
    const m = Math.floor(ms / 60_000);
    if (m < 60)  return `${m} دقيقة`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h} ساعة`;
    return `${Math.floor(h / 24)} يوم`;
  }
}
