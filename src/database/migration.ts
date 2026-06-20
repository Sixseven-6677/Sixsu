import fs   from "fs";
import path from "path";
import { LoggerManager } from "../logger/LoggerManager";

// ── Normal top-level model imports (no lazy require needed — models have no
//    transitive dependency back to migration.ts, so there is no circular dep).
import { BotConfigModel }     from "./models/bot-config.model";
import { BlackConfigModel }   from "./models/black-config.model";
import { BotAdminModel }      from "./models/botadmin.model";
import { GroupSettingsModel } from "./models/group-settings.model";
import { BanModel }           from "./models/ban.model";

const log = LoggerManager.getLogger("Migration");

// ─── Flag file ────────────────────────────────────────────────────────────────

const DONE_FLAG = path.resolve("data/.migration-done");

function hasDone(): boolean {
  return fs.existsSync(DONE_FLAG);
}

function markDone(): void {
  try {
    const dir = path.dirname(DONE_FLAG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DONE_FLAG, new Date().toISOString(), "utf8");
  } catch { /* best effort */ }
}

// ─── Per-collection migrations ────────────────────────────────────────────────

async function migratePrefix(): Promise<number> {
  const src = path.resolve("data/prefix.json");
  if (!fs.existsSync(src)) return 0;

  let count = 0;
  try {
    const raw  = JSON.parse(fs.readFileSync(src, "utf8")) as { prefix?: string };
    const pref = raw.prefix;
    if (pref && pref.length > 0) {
      await BotConfigModel.findOneAndUpdate(
        { key: "prefix" },
        { $set: { value: pref, updatedAt: new Date() }, $setOnInsert: { key: "prefix" } },
        { upsert: true }
      ).exec();
      log.info(`Migration: prefix → "${pref}"`);
      count = 1;
    }
  } catch (err) {
    log.warn("Migration: prefix failed.", { error: String(err) });
  }
  return count;
}

async function migrateBlack(): Promise<number> {
  const src = path.resolve("data/black-plugin.json");
  if (!fs.existsSync(src)) return 0;

  let count = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(src, "utf8")) as {
      threads?: Record<string, { message: string; intervalSec: number; active: boolean; lastSentAt: string | null }>;
    };

    for (const [threadId, cfg] of Object.entries(raw.threads ?? {})) {
      await BlackConfigModel.findOneAndUpdate(
        { threadId },
        {
          $set:         {
            message:     cfg.message,
            intervalSec: cfg.intervalSec,
            active:      cfg.active,
            lastSentAt:  cfg.lastSentAt ? new Date(cfg.lastSentAt) : null,
            updatedAt:   new Date(),
          },
          $setOnInsert: { threadId },
        },
        { upsert: true }
      ).exec();
      count++;
    }
    if (count > 0) log.info(`Migration: black-config → ${count} thread(s).`);
  } catch (err) {
    log.warn("Migration: black-config failed.", { error: String(err) });
  }
  return count;
}

async function migrateAdmins(): Promise<number> {
  const src = path.resolve("data/admin-store.json");
  if (!fs.existsSync(src)) return 0;

  let count = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(src, "utf8")) as { admins?: string[] };
    for (const fbId of (raw.admins ?? [])) {
      await BotAdminModel.findOneAndUpdate(
        { fbId },
        { $setOnInsert: { fbId, addedBy: "migration:file", addedAt: new Date() } },
        { upsert: true }
      ).exec();
      count++;
    }
    if (count > 0) log.info(`Migration: bot-admins → ${count} record(s).`);
  } catch (err) {
    log.warn("Migration: bot-admins failed.", { error: String(err) });
  }
  return count;
}

async function migrateLockdown(): Promise<number> {
  const src = path.resolve("data/lockdown.json");
  if (!fs.existsSync(src)) return 0;

  let count = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(src, "utf8")) as { threads?: Record<string, boolean> };
    for (const [threadId, locked] of Object.entries(raw.threads ?? {})) {
      await GroupSettingsModel.findOneAndUpdate(
        { threadId },
        {
          $set:         { lockdown: !!locked, updatedAt: new Date() },
          $setOnInsert: { threadId },
        },
        { upsert: true }
      ).exec();
      count++;
    }
    if (count > 0) log.info(`Migration: lockdown → ${count} thread(s).`);
  } catch (err) {
    log.warn("Migration: lockdown failed.", { error: String(err) });
  }
  return count;
}

async function migrateBans(): Promise<number> {
  const src = path.resolve("data/bans.json");
  if (!fs.existsSync(src)) return 0;

  let count = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(src, "utf8")) as {
      bans?: Record<string, { reason?: string; bannedAt: string; expiresAt: string | null; bannedBy?: string }>;
    };
    for (const [userId, ban] of Object.entries(raw.bans ?? {})) {
      await BanModel.findOneAndUpdate(
        { userId },
        {
          $set: {
            reason:    ban.reason,
            bannedAt:  new Date(ban.bannedAt),
            expiresAt: ban.expiresAt ? new Date(ban.expiresAt) : null,
            bannedBy:  ban.bannedBy,
          },
          $setOnInsert: { userId },
        },
        { upsert: true }
      ).exec();
      count++;
    }
    if (count > 0) log.info(`Migration: bans → ${count} record(s).`);
  } catch (err) {
    log.warn("Migration: bans failed.", { error: String(err) });
  }
  return count;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Runs once per deployment when data/*.json files exist.
 * Imports file-based data into MongoDB and stamps a flag so it never re-runs.
 */
export async function runMigrationIfNeeded(): Promise<void> {
  if (hasDone()) {
    log.debug("Migration: already done — skipping.");
    return;
  }

  const dataDir    = path.resolve("data");
  const hasAnyJson = fs.existsSync(dataDir) &&
    fs.readdirSync(dataDir).some((f) => f.endsWith(".json"));

  if (!hasAnyJson) {
    log.debug("Migration: no JSON data files found — nothing to migrate.");
    markDone();
    return;
  }

  log.info("Migration: JSON data found — starting import to MongoDB...");

  const results = await Promise.all([
    migratePrefix(),
    migrateBlack(),
    migrateAdmins(),
    migrateLockdown(),
    migrateBans(),
  ]);

  const total = results.reduce((s, n) => s + n, 0);
  log.info(`Migration: complete — ${total} record(s) imported to MongoDB.`);
  markDone();
}
