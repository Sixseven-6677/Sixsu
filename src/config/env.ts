import dotenv from "dotenv";
import path   from "path";

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  port:    parseInt(process.env["PORT"] ?? "3000", 10),
  nodeEnv: process.env["NODE_ENV"] ?? "development",

  facebook: {
    pageAccessToken: requireEnv("FB_PAGE_ACCESS_TOKEN"),
    verifyToken:     requireEnv("FB_VERIFY_TOKEN"),
    appSecret:       requireEnv("FB_APP_SECRET"),
  },

  bot: {
    prefix:      optionalEnv("BOT_PREFIX", "/"),
    commandsDir: optionalEnv("COMMANDS_DIR", "src/commands/definitions"),
  },

  database: {
    mongoUri: optionalEnv("MONGODB_URI", ""),
  },

  auth: {
    appStateEnvKey:  optionalEnv("FB_APPSTATE_ENV_KEY", "FB_APPSTATE"),
    appStateFile:    optionalEnv("FB_APPSTATE_FILE", ""),
    sessionFile:     optionalEnv("FB_SESSION_FILE", path.resolve("data/sessions.json")),
    sessionSecret:   optionalEnv("FB_SESSION_SECRET", requireEnv("SESSION_SECRET")),
    sessionTtlDays:  parseInt(optionalEnv("FB_SESSION_TTL_DAYS", "30"), 10),
  },

  logger: {
    level:      (optionalEnv("LOG_LEVEL", "info")) as "debug" | "info" | "warn" | "error",
    dir:        optionalEnv("LOG_DIR", "logs"),
    enableFile: process.env["LOG_FILE"] !== "false",
  },
} as const;

export type Config = typeof config;
