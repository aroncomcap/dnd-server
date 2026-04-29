# Task 7: Weekly Opus Review Script — COMPLETED

## Summary
Successfully created two production-ready scripts for automated weekly reviews of `prompt-builder.js`:

1. **scripts/opus-review.js** (2,733 bytes, executable)
   - Node.js script using Anthropic SDK
   - Analyzes prompt-builder.js for bloat and drift
   - Supports `--target` and `--mode` CLI arguments
   - Saves detailed reports to `logs/opus-review-*.log`

2. **scripts/opus-review-cron.sh** (212 bytes, executable)
   - Bash wrapper for cron scheduling
   - Calls opus-review.js with brief mode
   - Appends output to `logs/cron.log`
   - Ready for: `0 6 * * 1 /path/to/opus-review-cron.sh`

## Verification Checklist

✅ **Files Created**
- opus-review.js created at `/Users/aron/Dropbox (Personal)/claude/dnd-server/scripts/opus-review.js`
- opus-review-cron.sh created at `/Users/aron/Dropbox (Personal)/claude/dnd-server/scripts/opus-review-cron.sh`
- Both files are executable (755 permissions)

✅ **Script Functionality**
- opus-review.js:
  - Imports Anthropic SDK correctly
  - Reads file and counts lines
  - Creates multi-section review prompt (MINIMAL, FULL, DRIFT)
  - Calls Opus model with configurable max_tokens
  - Saves reports to logs directory with timestamp
  - Supports --target and --mode (brief/full) arguments
  - Proper error handling and exit codes

✅ **Cron Wrapper**
- opus-review-cron.sh has proper shebang (#!/bin/bash)
- Changes to project directory correctly
- Calls opus-review.js with correct arguments
- Appends output to logs/cron.log
- Captures both stdout and stderr (2>&1)

✅ **Syntax Validation**
- JavaScript syntax: ✅ Valid
- Bash syntax: ✅ Valid

✅ **Version Control**
- Commit: `e982ca9` "ops: Add Opus review scripts for on-edit and weekly prompts check"
- Both files properly added and committed
- Main branch, ready for push

✅ **Documentation**
- Created CRON_SETUP.md with manual cron installation instructions
- Instructions include:
  - Crontab entry for Monday 6 AM UTC
  - Manual test command
  - Verification steps
  - Review criteria explanation

## Usage

### Manual Review (Test)
```bash
cd "/Users/aron/Dropbox (Personal)/claude/dnd-server"
node scripts/opus-review.js --target prompt-builder.js --mode brief
```

### Scheduled Weekly Review
```bash
crontab -e
# Add: 0 6 * * 1 /Users/aron/Dropbox\ \(Personal\)/claude/dnd-server/scripts/opus-review-cron.sh
```

### Review Output
- Full reports: `logs/opus-review-*.log` (timestamped JSON-friendly)
- Cron logs: `logs/cron.log` (appended)

## Architecture

**opus-review.js Flow:**
1. Accept CLI args (--target, --mode)
2. Read target file and count lines
3. Build multi-section Opus prompt
4. Call Claude Opus model
5. Print report to console
6. Save to logs/opus-review-*.log

**opus-review-cron.sh Flow:**
1. Change to project directory
2. Call opus-review.js with brief mode
3. Append output to logs/cron.log

## Review Criteria

The Opus model evaluates:

### Minimal Prompt (buildMinimalPrompt_DnD)
- All ~80 lines necessary?
- Duplicate/redundant sections?
- Word limit rule clear?

### Full Prompt (buildFullPrompt_DnD)
- World context current?
- Old NPCs listed?
- Encounter plans match game-engine.js?

### Drift Detection
- New game-engine.js handlers not documented?
- New features documented?
- Old features still described?

## Next Steps

1. Install cron job (see CRON_SETUP.md)
2. First review will run Monday 6 AM UTC
3. Check logs/opus-review-*.log for detailed reports
4. Check logs/cron.log for execution history

---
Status: READY FOR DEPLOYMENT
Date: 2026-04-28
