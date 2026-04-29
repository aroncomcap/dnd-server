# Cron Job Setup for Weekly Opus Reviews

## Manual Setup (if needed)

To schedule the weekly Opus review, edit your crontab:

```bash
crontab -e
```

Add this line to schedule reviews every Monday at 6 AM UTC:

```cron
0 6 * * 1 /Users/aron/Dropbox\ \(Personal\)/claude/dnd-server/scripts/opus-review-cron.sh
```

Note: Escape the spaces in the path with backslashes as shown above.

## Verification

To verify the cron job is installed:

```bash
crontab -l | grep opus-review
```

## Manual Test

To run the review manually without waiting for cron:

```bash
cd /Users/aron/Dropbox\ \(Personal\)/claude/dnd-server
node scripts/opus-review.js --target prompt-builder.js --mode brief
```

## Files

- `scripts/opus-review.js` - Main review script (uses Opus model)
- `scripts/opus-review-cron.sh` - Cron wrapper (calls opus-review.js with brief mode)
- `logs/opus-review-*.log` - Review report logs (created by opus-review.js)
- `logs/cron.log` - Cron execution log (appended by opus-review-cron.sh)

## How It Works

1. **Weekly Trigger**: Cron runs `opus-review-cron.sh` every Monday at 6 AM
2. **Brief Mode**: Uses `--mode brief` to only report issues found
3. **File Path**: Analyzes `prompt-builder.js` in the project root
4. **Logging**: Saves detailed reports to `logs/opus-review-*.log`
5. **Cron Log**: Appends execution summary to `logs/cron.log`

## Review Criteria

The Opus model checks:

### Minimal Prompt
- Are all ~80 lines necessary?
- Any duplicate/redundant sections?
- Is word limit rule clear?

### Full Prompt
- Is world context still relevant?
- Are old NPCs still listed?
- Do encounter plans match game-engine.js?

### Drift Detection
- New handlers in game-engine.js not in prompt?
- New game features documented?
- Old features still described but removed?

