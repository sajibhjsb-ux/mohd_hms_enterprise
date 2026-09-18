#!/bin/bash
# Production launcher for the standalone Next.js server.
# Reads configuration from the (gitignored) .env file — never hardcode secrets.
set -a
[ -f ./.env ] && . ./.env
set +a
export NODE_ENV=production
export PORT="${PORT:-3000}"
export HOSTNAME=0.0.0.0
export NEXT_TELEMETRY_DISABLED=1
exec bun .next/standalone/server.js