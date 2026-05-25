#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sixsu Bot — Production Deployment Script (VPS / PM2)
#
# For Railway deployments, push to the main branch — Railway auto-deploys.
# This script is for VPS deployments managed via PM2.
#
# Usage:
#   bash deploy.sh              # first-time deploy (production)
#   bash deploy.sh --restart    # rebuild + graceful reload existing process
#   bash deploy.sh --stop       # stop the bot
#   bash deploy.sh --status     # show PM2 status
#   bash deploy.sh --logs       # stream live logs
#   bash deploy.sh --health     # check /health endpoint
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_NAME="sixsu-bot"
ENV="${NODE_ENV:-production}"
PORT="${PORT:-3000}"
HEALTH_URL="http://localhost:${PORT}/health"

# ─── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[deploy]${RESET} $*"; }
success() { echo -e "${GREEN}[deploy]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[deploy]${RESET} $*"; }
fatal()   { echo -e "${RED}[deploy] FATAL:${RESET} $*" >&2; exit 1; }

# ─── Flags ────────────────────────────────────────────────────────────────────
MODE="start"
for arg in "$@"; do
  case "$arg" in
    --restart) MODE="restart" ;;
    --stop)    MODE="stop"    ;;
    --status)  MODE="status"  ;;
    --logs)    MODE="logs"    ;;
    --health)  MODE="health"  ;;
    --help|-h)
      sed -n '2,12p' "$0" | sed 's/^# //;s/^#//'
      exit 0
      ;;
    *)
      warn "Unknown flag: $arg  (run with --help for usage)"
      ;;
  esac
done

# ─── Guards ───────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fatal "node is not installed."
command -v pnpm >/dev/null 2>&1 || fatal "pnpm is not installed."
command -v pm2  >/dev/null 2>&1 || fatal "pm2 is not installed. Run: npm install -g pm2"

[[ -f ".env" ]] || warn ".env file not found — make sure env vars are set in the environment."
[[ -f "ecosystem.config.js" ]] || fatal "ecosystem.config.js not found. Run from the project root."

# ─── Health check helper ──────────────────────────────────────────────────────
check_health() {
  local retries=10
  local wait=3
  info "Waiting for /health endpoint..."
  for i in $(seq 1 "$retries"); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      success "Health check passed (attempt $i/$retries)"
      return 0
    fi
    echo -e "  Attempt $i/$retries — retrying in ${wait}s..."
    sleep "$wait"
  done
  warn "Health check did not pass after $retries attempts — check logs."
  return 1
}

# ─── Build helper ────────────────────────────────────────────────────────────
run_build() {
  info "Installing dependencies..."
  pnpm install --frozen-lockfile

  info "Running TypeScript typecheck..."
  pnpm run typecheck

  info "Building TypeScript → dist/..."
  pnpm run build

  [[ -f "dist/index.js" ]] || fatal "Build failed: dist/index.js not found."
  success "Build successful."
}

# ─── Actions ──────────────────────────────────────────────────────────────────
case "$MODE" in

  # ── health ────────────────────────────────────────────────────────────────
  health)
    if curl -sf "$HEALTH_URL"; then
      echo ""
      success "Bot is healthy at ${HEALTH_URL}"
    else
      fatal "Health check failed — bot may not be running."
    fi
    exit 0
    ;;

  # ── stop ──────────────────────────────────────────────────────────────────
  stop)
    info "Stopping $APP_NAME..."
    pm2 stop "$APP_NAME" 2>/dev/null || warn "$APP_NAME is not running."
    success "Stopped."
    exit 0
    ;;

  # ── status ─────────────────────────────────────────────────────────────────
  status)
    pm2 status
    exit 0
    ;;

  # ── logs ───────────────────────────────────────────────────────────────────
  logs)
    exec pm2 logs "$APP_NAME"
    ;;

  # ── restart (graceful reload, zero downtime) ────────────────────────────────
  restart)
    run_build

    if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
      info "Reloading $APP_NAME (graceful — zero downtime)..."
      pm2 reload ecosystem.config.js --env "$ENV"
    else
      warn "$APP_NAME not found in PM2 — starting fresh."
      pm2 start ecosystem.config.js --env "$ENV"
    fi

    pm2 save
    check_health || true
    success "Reloaded successfully."
    exit 0
    ;;

  # ── start (first-time deploy) ────────────────────────────────────────────
  start)
    run_build

    info "Creating logs/ directory..."
    mkdir -p logs

    if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
      warn "$APP_NAME already running — use --restart to reload."
      pm2 status
      exit 0
    fi

    info "Starting $APP_NAME in $ENV mode (PORT=$PORT)..."
    pm2 start ecosystem.config.js --env "$ENV"

    info "Saving PM2 process list..."
    pm2 save

    check_health || true

    echo ""
    success "${BOLD}Deployment complete!${RESET}"
    echo -e "  ${CYAN}Health:${RESET} bash deploy.sh --health"
    echo -e "  ${CYAN}Logs:${RESET}   pm2 logs $APP_NAME"
    echo -e "  ${CYAN}Status:${RESET} pm2 status"
    echo -e "  ${CYAN}Stop:${RESET}   bash deploy.sh --stop"
    echo ""

    pm2 status
    ;;
esac
