import dotenv from "dotenv";

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "3000", 10),
  nodeEnv: process.env["NODE_ENV"] ?? "development",
  facebook: {
    pageAccessToken: requireEnv("FB_PAGE_ACCESS_TOKEN"),
    verifyToken: requireEnv("FB_VERIFY_TOKEN"),
    appSecret: requireEnv("FB_APP_SECRET"),
  },
  bot: {
    prefix: process.env["BOT_PREFIX"] ?? "/",
    commandsDir: process.env["COMMANDS_DIR"] ?? "src/commands/definitions",
  },
} as const;

export type Config = typeof config;
