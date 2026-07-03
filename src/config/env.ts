import dotenv from "dotenv";
import path   from "path";

dotenv.config();

function optionalEnv(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

const isProd               = (process.env["NODE_ENV"] ?? "") === "production";
const DEFAULT_COMMANDS_DIR = isProd ? "dist/commands/definitions" : "src/commands/definitions";
const DEFAULT_PLUGINS_DIR  = isProd ? "dist/plugins/definitions"  : "src/plugins/definitions";

function resolveSessionSecret(): string {
  return (
    process.env["FB_SESSION_SECRET"] ??
    process.env["SESSION_SECRET"]    ??
    ""
  );
}

export const config = {
  port:    parseInt(process.env["PORT"] ?? "3000", 10),
  nodeEnv: process.env["NODE_ENV"] ?? "development",

  facebook: {
    pageAccessToken: optionalEnv("FB_PAGE_ACCESS_TOKEN"),
    verifyToken:     optionalEnv("FB_VERIFY_TOKEN", ""),
    appSecret:       optionalEnv("FB_APP_SECRET", ""),
  },

  bot: {
    prefix:      optionalEnv("BOT_PREFIX", "/"),
    commandsDir: optionalEnv("COMMANDS_DIR", DEFAULT_COMMANDS_DIR),
    adminIds:    optionalEnv("BOT_ADMIN_IDS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ownerIds:    optionalEnv("BOT_OWNER_IDS", "61589140635720")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  plugins: {
    dir:   optionalEnv("PLUGINS_DIR", DEFAULT_PLUGINS_DIR),
    watch: process.env["PLUGINS_WATCH"] !== "false",
  },

  database: {
    mongoUri: optionalEnv("MONGODB_URI"),
  },

  auth: {
    // ── AppState (Stage 1 — primary login method) ─────────────────────────
    appStateEnvKey:  optionalEnv("FB_APPSTATE_ENV_KEY",  "FB_APPSTATE"),
    appStateFile:    optionalEnv("FB_APPSTATE_FILE"),
    // ── Secondary account (optional — set FB_APPSTATE_2 to activate) ─────
    appStateEnvKey2: optionalEnv("FB_APPSTATE_ENV_KEY_2", "FB_APPSTATE_2"),
    appStateFile2:   optionalEnv("FB_APPSTATE_FILE_2"),

    // ── Watched state file (Nejin-style single-file session, encrypted at
    // rest via CryptoHelper). When set, takes priority over appStateFile /
    // appStateEnvKey for the primary account — an operator can drop fresh
    // cookies into this file and the bot re-authenticates automatically.
    appStateWatchFile: optionalEnv("FB_APPSTATE_WATCH_FILE"),

    // ── Email/Password fallback (Stage 2 — only used when AppState fails) ─
    // The password value is NEVER read here — only presence is checked.
    // EmailPasswordProvider.fromEnv() reads FB_EMAIL / FB_PASSWORD directly.
    hasEmailFallback: !!(process.env["FB_EMAIL"] && process.env["FB_PASSWORD"]),

    sessionFile:    optionalEnv("FB_SESSION_FILE", path.resolve("data/sessions.json")),
    sessionSecret:  resolveSessionSecret(),
    sessionTtlDays: parseInt(optionalEnv("FB_SESSION_TTL_DAYS", "30"), 10),
  },

  logger: {
    level:      optionalEnv("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
    dir:        optionalEnv("LOG_DIR", "logs"),
    enableFile: process.env["LOG_FILE"] !== "false",
  },
} as const;

export type Config = typeof config;
