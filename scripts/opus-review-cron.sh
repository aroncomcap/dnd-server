#!/bin/bash
# Weekly Opus review cron job
# Schedule: 0 6 * * 1 (Every Monday at 6 AM UTC)

cd "$(dirname "$0")/.."
node scripts/opus-review.js --target prompt-builder.js --mode brief 2>&1 | tee -a logs/cron.log
