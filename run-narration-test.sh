#!/bin/bash
# Run narration test with TEST_MODE enabled

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  NARRATION TEST WITH AUTO-GAME-CREATION                   ║"
echo "║  Starting server in TEST_MODE, then running test           ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

cd "$(dirname "$0")"

# Kill any existing processes on port 3000
echo "🛑 Cleaning up port 3000..."
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

# Start server in TEST_MODE
echo "🚀 Starting server with TEST_MODE=true..."
export TEST_MODE=true
export NODE_ENV=test

npm start &
SERVER_PID=$!
echo "   Server PID: $SERVER_PID"

# Wait for server to be ready
echo "⏳ Waiting for server to start..."
for i in {1..30}; do
  if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "✅ Server ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "❌ Server failed to start"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

sleep 2

# Run test
echo ""
echo "📋 Running narration test..."
node test-with-narration.js

# Cleanup
echo ""
echo "🛑 Stopping server..."
kill $SERVER_PID 2>/dev/null || true

echo ""
echo "✅ Test complete. Check TEST-RESULTS.json for details."
