const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const gameHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const narrationPipelineJs = fs.readFileSync(path.join(__dirname, '..', 'narration-pipeline.js'), 'utf8');
const gameActionTs = fs.readFileSync(path.join(__dirname, 'e2e', 'game-action.ts'), 'utf8');
const campaignVerboseTs = fs.readFileSync(path.join(__dirname, 'e2e', 'campaign-verbose.spec.ts'), 'utf8');

test('game inline script parses', () => {
  const start = gameHtml.indexOf('<script>');
  const end = gameHtml.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'main game script should exist');
  assert.doesNotThrow(() => new Function(gameHtml.slice(start + '<script>'.length, end)));
});

test('game navigation binding is invoked', () => {
  const navBlock = gameHtml.match(/\/\/ ── Navigation[\s\S]*?\/\/ ── Player name persistence/);
  assert.ok(navBlock, 'navigation script block should exist');
  assert.match(navBlock[0], /\}\)\(\);\s*\/\/ ── Player name persistence/, 'navigation setup IIFE must be invoked');
});

test('DM rendering strips structured marker blocks before display', () => {
  assert.match(gameHtml, /function stripStructuredBlocksFromNarration\(text\)/, 'structured block sanitizer should exist');
  assert.match(gameHtml, /let cleaned = stripStructuredBlocksFromNarration\(text\)/, 'renderDmText should sanitize all DM text');
  assert.match(gameHtml, /const finalText = stripStructuredBlocksFromNarration\(narration \|\| body\.textContent \|\| ''\)/, 'stream finalizer should sanitize fallback text');
});

test('E2E action waiter requires a new completed DM message', () => {
  assert.match(gameActionTs, /return completedDmCount > before;/, 'waitForActionResponse should require a new completed DM message');
  assert.doesNotMatch(gameActionTs, /completedDmCount > before\s*\|\|/, 'idle send button should not count as an action response');
});

test('E2E campaign harness waits for already pending accepted actions', () => {
  assert.match(gameActionTs, /export async function isActionResponsePending/, 'E2E helpers should expose actionable pending response state');
  assert.match(gameActionTs, /export async function waitForPendingActionToSettle/, 'E2E helpers should allow pending state to settle without requiring a duplicate response');
  assert.match(campaignVerboseTs, /await isActionResponsePending\(page\)/, 'verbose campaign should detect an already pending action');
  assert.match(campaignVerboseTs, /pendingResult === 'settled'/, 'campaign should keep moving when a pending action has already settled');
  assert.match(campaignVerboseTs, /Pending action did not produce a completed DM response/, 'pending action stalls should be diagnosed separately');
  assert.match(campaignVerboseTs, /const responseReady = responseAlreadyReady \|\| await waitForActionResponse/, 'campaign should not wait twice after an in-flight response already completed');
});

test('streamed narration failures are finalized instead of leaving a live stream bubble', () => {
  assert.match(gameHtml, /function finalizeStreamBubble\(narration, llmRunId = null\)/, 'client should have a reusable stream finalizer');
  assert.match(gameHtml, /socket\.on\('dm_stream_end'[\s\S]*?finalizeStreamBubble\(narration, data\.llmRunId\);/, 'stream end should finalize the live stream bubble');
  assert.match(gameHtml, /if \(lastMessageWasStreamed\) \{[\s\S]*?finalizeStreamBubble\(data\.text, data\.llmRunId\);[\s\S]*?lastMessageWasStreamed = false;/, 'fallback dm_message should finalize an orphaned stream bubble');
  assert.match(narrationPipelineJs, /const closeStream = \(narration, llmRunId = null\) => \{[\s\S]*?dm_stream_end[\s\S]*?streamEnded = true;/, 'split pipeline should centralize stream closure');
  assert.match(narrationPipelineJs, /catch \(err\) \{[\s\S]*?buildFallbackTurn\(characterName, actionText\);[\s\S]*?closeStream\(fullText\.trim\(\) \|\| fallback\.narration, err\.llmRunId \|\| null\);[\s\S]*?fallback: true/, 'split pipeline should emit a playable fallback when model streaming fails');
  assert.match(narrationPipelineJs, /const FALLBACK_OPTIONS = \[[\s\S]*?Press forward cautiously/, 'split pipeline should keep fallback turns actionable');
  assert.match(narrationPipelineJs, /options: \[\.\.\.FALLBACK_OPTIONS\]/, 'narration failures should emit fallback options');
  assert.match(narrationPipelineJs, /if \(narrationResult\.fallback\) \{[\s\S]*?return \{[\s\S]*?fallback: true/, 'fallback narration should skip extra structured model calls');
});

test('AI party generation failures create a playable fallback party', () => {
  assert.match(serverJs, /function createFallbackParty\(system = 'dnd5e'\)/, 'server should define a deterministic fallback party');
  assert.match(serverJs, /Party generation failed:[\s\S]*?createFallbackParty\(gameConfig\.system \|\| 'dnd5e'\)/, 'party generation catch path should create fallback characters');
  assert.match(serverJs, /socket\.emit\('party_generated', \{ count: fallbackCount, fallback: true \}\);/, 'fallback party should unblock auto-start flow');
  assert.match(serverJs, /io\.to\(gameId\)\.emit\('party_ready', \{ count: fallbackCount,[\s\S]*?fallback: true \}\);/, 'fallback party should publish combat stats');
});

test('action submit is latched until a server response or long fallback', () => {
  assert.match(gameHtml, /let actionInFlight = false;/, 'action pending state should be explicit');
  assert.match(gameHtml, /function resetSendButton\(\)/, 'there should be one reset path for the send button');
  assert.match(gameHtml, /window\._actionInFlight = false;/, 'diagnostics should see reset action state');
  assert.match(gameHtml, /window\._actionInFlight = true;/, 'diagnostics should see pending action state');
  assert.match(gameHtml, /function shouldResetActionForSystemMessage\(text\)/, 'only action-related system messages should reset pending action state');
  assert.match(gameHtml, /if \(actionInFlight && shouldResetActionForSystemMessage\(data\.text\)\) resetSendButton\(\);/, 'generic system messages should not clear pending action state');
  assert.match(gameHtml, /actionFallbackTimer = setTimeout\(resetSendButton, 90000\);/, 'fallback should be long enough to avoid duplicate slow-turn sends');
  assert.match(gameHtml, /socket\.on\('dm_message'[\s\S]*?resetSendButton\(\);/, 'DM responses should clear pending action state');
  assert.match(gameHtml, /socket\.on\('turn_change'[\s\S]*?resetSendButton\(\);/, 'turn changes should clear pending action state');
  assert.match(gameHtml, /socket\.on\('action_complete'[\s\S]*?resetSendButton\(\);/, 'action completion acknowledgements should clear pending action state');
  assert.match(gameHtml, /function sendAction\(\) \{\s*if \(actionInFlight\) return;/, 'duplicate sends should be ignored while pending');
  assert.doesNotMatch(gameHtml, /setTimeout\(\(\) => \{ sendBtn\.textContent = 'Send Action'; sendBtn\.disabled = false; \}, 15000\);/, 'short fixed resend timer should not return');
});

test('player actions survive socket reconnects', () => {
  assert.match(gameHtml, /let gameJoinReady = false;/, 'client should track whether this socket has joined the game room');
  assert.match(gameHtml, /function requestGameJoin\(\)[\s\S]*?socket\.emit\('join_game', gameId\);/, 'client should have a reusable join request');
  assert.match(gameHtml, /socket\.on\('connect'[\s\S]*?requestGameJoin\(\);[\s\S]*?updateActionArea\(\);/, 'client should rejoin the room after reconnect');
  assert.match(gameHtml, /socket\.on\('disconnect'[\s\S]*?gameJoinReady = false;[\s\S]*?updateActionArea\(\);/, 'client should mark actions unavailable after disconnect');
  assert.match(gameHtml, /if \(!socket\.connected \|\| !gameJoinReady\)[\s\S]*?return;/, 'sendAction should not locally echo actions before the socket rejoins');
  assert.match(gameHtml, /socket\.timeout\(ACTION_ACK_TIMEOUT_MS\)\.emit\('player_action', \{ gameId, playerName: name, action \}/, 'player actions should include gameId as a reconnect recovery fallback');
  assert.match(serverJs, /if \(!gameId && typeof data\?\.gameId === 'string'\)[\s\S]*?socket\.join\(requestedGameId\);[\s\S]*?socket\.gameId = requestedGameId;/, 'server should recover buffered actions from sockets that reconnected before join_game');
});

test('player actions wait for server receipt before entering pending DM state', () => {
  assert.match(gameHtml, /const ACTION_ACK_TIMEOUT_MS = 8000;/, 'client should use a short action receipt timeout');
  assert.match(gameHtml, /function markActionSending\(\)/, 'client should distinguish sending from waiting on DM narration');
  assert.match(gameHtml, /if \(err \|\| !ack\?\.ok\)[\s\S]*?resetSendButton\(\);[\s\S]*?input\.value = action;/, 'lost action emits should reset and restore the typed action');
  assert.match(gameHtml, /ack\?\.ok[\s\S]*?addMsg\('player', action, getMyName\(\)\);[\s\S]*?showThinkingIndicator\(\);[\s\S]*?markActionPending\(\);/, 'client should echo and show thinking only after server receipt');
  assert.match(serverJs, /socket\.on\('player_action', async \(data, ack\) =>/, 'server should accept a Socket.IO action acknowledgement callback');
  assert.match(serverJs, /ackAction\(\{ ok: true \}\);[\s\S]*?io\.to\(gameId\)\.emit\('player_message'/, 'server should acknowledge accepted actions before expensive DM generation');
});

test('combat loading state preserves and restores action controls', () => {
  const combatInitBlock = gameHtml.match(/socket\.on\('combat_initializing'[\s\S]*?\n}\);/);
  assert.ok(combatInitBlock, 'combat_initializing handler should exist');
  assert.match(gameHtml, /function ensureWaitingMessageStructure\(\)/, 'waiting panel should be restorable after temporary combat loading UI');
  assert.doesNotMatch(combatInitBlock[0], /waitMsg\.innerHTML\s*=/, 'combat loading should not replace the waiting panel shell');
  assert.match(combatInitBlock[0], /waitingName\.innerHTML\s*=/, 'combat loading should write inside the preserved waiting-name node');
  assert.match(gameHtml, /socket\.on\('combat_started'[\s\S]*?updateActionArea\(\);/, 'combat_started should restore action controls');
  assert.match(gameHtml, /socket\.on\('combat_update'[\s\S]*?updateActionArea\(\);/, 'combat_update should also restore controls if combat_started was missed');
});

test('combat victories award XP and publish character level updates', () => {
  assert.match(serverJs, /awardCombatXpForGame/, 'server should award XP when combat ends');
  assert.match(serverJs, /character_updated'[\s\S]*?leveledUp/, 'level changes should be pushed through character_updated events');
  assert.match(serverJs, /XP awarded:/, 'players should see an XP grant system message');
  assert.match(serverJs, /combat_ended'[\s\S]*?xp:/, 'combat_ended payload should include the XP award summary');
});
