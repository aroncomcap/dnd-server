#!/bin/bash
# ────────────────────────────────────────────────────────────────────────────────
# Post-commit Hook: Opus Review Trigger
#
# Triggers automated Opus analysis when prompt-builder.js is modified.
# Non-blocking informational hook (does not prevent commits).
#
# Installation:
#   cp scripts/post-commit-opus-review.sh .git/hooks/post-commit
#   chmod +x .git/hooks/post-commit
# ────────────────────────────────────────────────────────────────────────────────

set -e

# Get the list of files modified in the latest commit
MODIFIED_FILES=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || echo "")

# Check if prompt-builder.js was modified
if echo "$MODIFIED_FILES" | grep -q "prompt-builder.js"; then
  echo "📋 Opus Review: prompt-builder.js changed"

  # Run the Opus review script if it exists
  # Task 7 will implement scripts/opus-review.js
  if [ -f "$(git rev-parse --show-toplevel)/scripts/opus-review.js" ]; then
    node "$(git rev-parse --show-toplevel)/scripts/opus-review.js" || true
  fi
fi

exit 0
