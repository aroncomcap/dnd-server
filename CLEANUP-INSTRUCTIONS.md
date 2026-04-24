# Cleanup: Delete All Games and Characters

## Method 1: Via Railway CLI (Recommended)

```bash
cd /Users/aron/Dropbox\ \(Personal\)/claude/dnd-server
railway shell
CONFIRM_DELETE=yes node cleanup-all-data.js
```

This runs in the Railway environment where DATABASE_URL is set.

## Method 2: Via Direct SQL (Railway Postgres)

Open Railway PostgreSQL plugin and run:

```sql
-- Delete dependent data first
DELETE FROM game_state;
DELETE FROM channel_links;
DELETE FROM rules_corrections;
DELETE FROM monster_templates;
DELETE FROM bug_reports;

-- Delete characters
DELETE FROM characters;

-- Delete games
DELETE FROM games;

-- Verify
SELECT COUNT(*) as games FROM games;
SELECT COUNT(*) as characters FROM characters;
```

## Method 3: Create Database Admin Endpoint

Could add a protected `/api/admin/cleanup` endpoint that requires authentication to:
- Delete all games
- Delete all characters
- Clear all related data

Would need:
- Admin auth check
- Confirmation header requirement
- Audit logging

## Current Status

- ✅ cleanup-all-data.js script created
- ✅ Safe guards included (counts, confirmation check)
- ⏳ Ready to run via Railway CLI or direct SQL

## After Cleanup

- All games deleted from database
- All characters deleted from database
- Game state, rules, templates, and bug reports cleaned up
- Fresh database for new testing
