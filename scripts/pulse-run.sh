#!/usr/bin/env sh
# Scheduled job for cron: sync, extract, enrich. Logs to logs/.
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
npm run --silent pulse -- run >> "logs/pulse-$(date +%F).log" 2>&1
