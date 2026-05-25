import { ModerationDocument } from "../db/moderation.model";

export const MOD_SERVICES = {
  MODERATION:       "moderation-service",
  BAN_STORE:        "ban-store",
  RESPONSE_BUILDER: "response-builder",
} as const;

export interface BanOptions  { reason?: string; durationMs?: number; }
export interface MuteOptions { reason?: string; durationMs?: number; }

export interface ModerationResult {
  ok:          boolean;
  action:      string;
  targetId:    string;
  message:     string;
  warnCount?:  number;
  autoBanned?: boolean;
}

export interface ModerationRecord {
  id:          string;
  targetId:    string;
  actorId:     string;
  action:      string;
  reason?:     string;
  durationMs?: number;
  expiresAt?:  Date;
  active:      boolean;
  createdAt:   Date;
}

export function toRecord(doc: ModerationDocument): ModerationRecord {
  return {
    id:         (doc._id as { toString(): string }).toString(),
    targetId:   doc.targetId,
    actorId:    doc.actorId,
    action:     doc.action,
    reason:     doc.reason,
    durationMs: doc.durationMs,
    expiresAt:  doc.expiresAt,
    active:     doc.active,
    createdAt:  doc.createdAt,
  };
}

export interface IModerationService {
  ban(targetId: string, actorId: string, opts?: BanOptions): Promise<ModerationResult>;
  unban(targetId: string, actorId: string): Promise<ModerationResult>;
  warn(targetId: string, actorId: string, reason?: string): Promise<ModerationResult>;
  mute(targetId: string, actorId: string, opts?: MuteOptions): Promise<ModerationResult>;
  unmute(targetId: string, actorId: string): Promise<ModerationResult>;
  kick(targetId: string, actorId: string, reason?: string): Promise<ModerationResult>;
  getHistory(targetId: string, limit?: number): Promise<ModerationRecord[]>;
  isActive(targetId: string, action: string): Promise<boolean>;
}

/** Minimal formatter interface — structurally matches utility plugin's ResponseBuilder. */
export interface IResponseBuilder {
  success(title: string, lines?: string[]): string;
  warn(message: string): string;
  info(lines: string[]): string;
  sep(): string;
}

export function parseModArgs(args: string[]): {
  userId: string;
  durationMs: number | undefined;
  reason: string | undefined;
} {
  const userId = args[0] ?? "";
  let durationMs: number | undefined;
  let reasonStart = 1;

  const durationArg = args[1];
  if (durationArg && /^\d+m$/i.test(durationArg)) {
    durationMs  = parseInt(durationArg, 10) * 60_000;
    reasonStart = 2;
  }

  const reason = args.slice(reasonStart).join(" ").trim() || undefined;
  return { userId, durationMs, reason };
}

export function fmtDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60)  return `${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)    return `${hours} ساعة`;
  return `${Math.floor(hours / 24)} يوم`;
}
