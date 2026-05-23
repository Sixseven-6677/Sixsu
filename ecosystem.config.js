"use strict";

/** @type {import("pm2").StartOptions[]} */
const APP_NAME = "sixsu-bot";
const LOG_DATE = "YYYY-MM-DD HH:mm:ss Z";

module.exports = {
  apps: [
    {
      // ─── Identity ────────────────────────────────────────────────────────
      name:      APP_NAME,
      script:    "dist/index.js",

      // ─── Runtime ─────────────────────────────────────────────────────────
      // Single-instance fork mode is required for a stateful bot:
      // SessionManager, BanStore and ReconnectManager all live in-memory.
      // Running multiple instances would cause divergent state.
      instances:  1,
      exec_mode:  "fork",
      node_args:  "--enable-source-maps",

      // ─── Auto-restart & Crash Recovery ───────────────────────────────────
      autorestart:        true,
      watch:              false,
      max_memory_restart: "512M",

      // max_restarts: number of consecutive crashes before PM2 stops
      // retrying and marks the app as "errored".
      max_restarts:  10,

      // min_uptime: process must be alive for this long to count as a
      // successful start. Prevents crash-loops from burning all restarts.
      min_uptime:    "15s",

      // restart_delay: wait before each restart attempt (ms).
      restart_delay: 5000,

      // exp_backoff_restart_delay: enable exponential backoff between
      // restarts so a crash-looping bot doesn't hammer the network.
      exp_backoff_restart_delay: 100,

      // ─── Graceful Shutdown ────────────────────────────────────────────────
      // SIGTERM is sent first; PM2 waits kill_timeout ms before SIGKILL.
      // Must be > runShutdownSteps timeout (10 000 ms) + safety buffer.
      kill_timeout:   15000,

      // wait_ready: PM2 will wait for process.send("ready") before
      // considering the app started. Enabled in src/index.ts bootstrap().
      wait_ready:     true,
      listen_timeout: 12000,

      // ─── Logging ─────────────────────────────────────────────────────────
      log_date_format: LOG_DATE,
      output:          "logs/pm2-out.log",
      error:           "logs/pm2-error.log",
      merge_logs:      true,

      // ─── Environments ─────────────────────────────────────────────────────
      // Activated with:  pm2 start ecosystem.config.js
      env: {
        NODE_ENV: "development",
        PORT:     3000,
      },

      // Activated with:  pm2 start ecosystem.config.js --env production
      env_production: {
        NODE_ENV: "production",
        PORT:     3000,
      },
    },
  ],
};
