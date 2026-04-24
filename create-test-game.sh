#!/bin/bash
# Create a test game via the server API

# This would normally be used to create a test game
# But since the API requires auth, we'll need to either:
# 1. Create it via Railway PostgreSQL directly
# 2. Use a public game creation endpoint (if available)
# 3. Manually create via web UI

# For now, this script documents how to create a game if needed

# First, you'd need to get a valid auth token from the web UI
# Then call:

GAME_NAME="Narrative Test $(date +%s)"
AUTH_TOKEN="${BEARER_TOKEN:- NOT_SET}"

if [ "$AUTH_TOKEN" == " NOT_SET" ]; then
  echo "❌ BEARER_TOKEN not set"
  echo "To create a game:"
  echo "1. Visit https://theystillsing.com"
  echo "2. Log in or create account"
  echo "3. Open DevTools Console and run: localStorage.getItem('tt_token')"
  echo "4. Set: export BEARER_TOKEN='<your_token>'"
  echo "5. Run this script again"
  exit 1
fi

echo "Creating game: $GAME_NAME"

curl -s -X POST "https://theystillsing.com/api/games" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$GAME_NAME\",\"system\":\"dnd5e\"}" | jq .
