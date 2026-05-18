const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const gameHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const gameEngineJs = fs.readFileSync(path.join(__dirname, '..', 'game-engine.js'), 'utf8');
const actionParserJs = fs.readFileSync(path.join(__dirname, '..', 'action-parser.js'), 'utf8');
const narrationPipelineJs = fs.readFileSync(path.join(__dirname, '..', 'narration-pipeline.js'), 'utf8');
const promptBuilderJs = fs.readFileSync(path.join(__dirname, '..', 'prompt-builder.js'), 'utf8');
const encounterDirectorJs = fs.readFileSync(path.join(__dirname, '..', 'encounter-director.js'), 'utf8');
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
  assert.match(narrationPipelineJs, /catch \(err\) \{[\s\S]*?buildFallbackTurn\(characterName, actionText\);[\s\S]*?closeStream\(visibleNarration\.trim\(\) \|\| fallback\.narration, err\.llmRunId \|\| null\);[\s\S]*?fallback: true/, 'split pipeline should emit a playable fallback when model streaming fails');
  assert.match(narrationPipelineJs, /const FALLBACK_OPTIONS = \[[\s\S]*?Advance to the next clear lead/, 'split pipeline should keep fallback turns actionable');
  assert.match(narrationPipelineJs, /options: \[\.\.\.FALLBACK_OPTIONS\]/, 'narration failures should emit fallback options');
  assert.match(narrationPipelineJs, /if \(narrationResult\.fallback\) \{[\s\S]*?return \{[\s\S]*?fallback: true/, 'fallback narration should skip extra structured model calls');
});

test('AI party generation failures create a playable fallback party', () => {
  assert.match(serverJs, /function createFallbackParty\(system = 'dnd5e'\)/, 'server should define a deterministic fallback party');
  assert.match(serverJs, /Party generation failed:[\s\S]*?createFallbackParty\(gameConfig\.system \|\| 'dnd5e'\)/, 'party generation catch path should create fallback characters');
  assert.match(serverJs, /socket\.emit\('party_generated', \{ count: fallbackCount, fallback: true \}\);/, 'fallback party should unblock auto-start flow');
  assert.match(serverJs, /io\.to\(gameId\)\.emit\('party_ready', \{ count: fallbackCount,[\s\S]*?fallback: true \}\);/, 'fallback party should publish combat stats');
  assert.match(gameHtml, /function startAutoAdventureWithParty\(\)/, 'auto-start should have one guarded path into dm_start');
  assert.match(gameHtml, /setTimeout\(startAutoAdventureWithParty, 12000\);/, 'auto-start should not leave the loading overlay blocking the host if party generation stalls');
  assert.match(campaignVerboseTs, /if \(await isLoadingOverlayActive\(page\)\) return false;/, 'campaign harness should not click through a blocking auto-start overlay');
});

test('game start guarantees a playable party before narration or combat', () => {
  assert.match(serverJs, /async function ensurePlayablePartyForStart\(gameId, gameConfig, gs, socket = null\)/, 'server should have a reusable start-time party guard');
  assert.match(serverJs, /socket\.on\('dm_start'[\s\S]*?await ensurePlayablePartyForStart\(gameId, gameConfig, gs, socket\);[\s\S]*?callGameLLM/, 'socket game start should create a fallback party before narration');
  assert.match(serverJs, /async startGame\(gameId, prompt\)[\s\S]*?await ensurePlayablePartyForStart\(gameId, gameConfig, gs\);[\s\S]*?callGameLLM/, 'engine game start should create a fallback party before narration');
  assert.match(serverJs, /socket\.on\('dm_start'[\s\S]*?await ensurePlayablePartyForStart\(gameId, gameConfig, gs, socket\);[\s\S]*?publishCurrentTurn\(gameId, gameConfig, \{ startTimer: false \}\);[\s\S]*?callGameLLM/, 'socket game start should publish the first turn before waiting on narration');
  assert.match(serverJs, /async startGame\(gameId, prompt\)[\s\S]*?await ensurePlayablePartyForStart\(gameId, gameConfig, gs\);[\s\S]*?publishCurrentTurn\(gameId, gameConfig, \{ startTimer: false \}\);[\s\S]*?callGameLLM/, 'engine game start should publish the first turn before waiting on narration');
  assert.match(serverJs, /if \(pcCombatants\.length === 0\) \{[\s\S]*?No player characters available for combat/, 'combat initialization should refuse enemy-only combat');
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
  assert.match(gameHtml, /if \(!currentPlayer\) return false; \/\/ wait until the table has loaded a real turn owner/, 'unknown turn state should not be treated as actionable');
  assert.match(gameHtml, /if \(!currentPlayer\) \{[\s\S]*?the table to finish loading/, 'unknown turn state should show a waiting message instead of action controls');
  assert.match(gameHtml, /if \(!currentPlayer\) \{[\s\S]*?Waiting for the table to finish loading before sending an action/, 'sendAction should not submit gameplay actions before a turn owner loads');
  assert.doesNotMatch(gameHtml, /setTimeout\(\(\) => \{ sendBtn\.textContent = 'Send Action'; sendBtn\.disabled = false; \}, 15000\);/, 'short fixed resend timer should not return');
});

test('player actions survive socket reconnects', () => {
  assert.match(gameHtml, /let gameJoinReady = false;/, 'client should track whether this socket has joined the game room');
  assert.match(gameHtml, /function requestGameJoin\(\)[\s\S]*?socket\.emit\('join_game', gameId\);/, 'client should have a reusable join request');
  assert.match(gameHtml, /socket\.on\('connect'[\s\S]*?requestGameJoin\(\);[\s\S]*?updateActionArea\(\);/, 'client should rejoin the room after reconnect');
  assert.match(gameHtml, /socket\.on\('disconnect'[\s\S]*?gameJoinReady = false;[\s\S]*?updateActionArea\(\);/, 'client should mark actions unavailable after disconnect');
  assert.match(gameHtml, /if \(!socket\.connected \|\| !gameJoinReady\)[\s\S]*?return;/, 'sendAction should not locally echo actions before the socket rejoins');
  assert.match(gameHtml, /const payload = \{ gameId, playerName: name, action \}/, 'player actions should include gameId as a reconnect recovery fallback');
  assert.match(gameHtml, /socket\.timeout\(ACTION_ACK_TIMEOUT_MS\)\.emit\('player_action', payload/, 'player actions should send the reconnect-safe payload');
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

test('dm options are scoped to the player receiving the next turn', () => {
  assert.match(serverJs, /sanitizeOptionsForPlayer/, 'server should guard against stale options for the wrong character');
  assert.match(serverJs, /optionsRetargeted/, 'retargeted options should be visible in the dm_message payload for diagnostics');
  assert.match(gameHtml, /pendingForPlayer && currentPlayer && pendingForPlayer !== currentPlayer/, 'client should clear options that belong to a different turn owner');
});

test('rejoin restores turn order and the last scene image', () => {
  assert.match(serverJs, /last_image_url/, 'server should load the persisted image URL on game rejoin');
  assert.match(gameHtml, /currentTurnOrder\.map\(name => \[name, \{\}\]\)/, 'party turn order should fall back to saved turnOrder when character data is missing');
  assert.match(gameHtml, /Object\.keys\(state\.characters \|\| \{\}\)\.length > 0 \|\| currentTurnOrder\.length > 0/, 'party turn order should render when either characters or saved turnOrder are present');
  assert.match(gameHtml, /if \(!turnOrderData \|\| !turnOrderData\.length\) \{[\s\S]*?showPartyTurnOrder\(\);[\s\S]*?return;/, 'empty world turnOrder should not hide the saved party turn order');
  assert.match(serverJs, /const joinedTurnOrder = gs\.data\.turnOrder\?\.length[\s\S]*?Object\.keys\(gs\.data\.characters \|\| \{\}\);/, 'server should send a turn order fallback on rejoin when persisted turnOrder is missing');
  assert.match(serverJs, /turnOrder: joinedTurnOrder/, 'game_joined should use the normalized rejoin turn order');
  assert.match(gameHtml, /sceneImg\.onerror/, 'scene image failures should hide the broken image instead of showing an empty panel');
});

test('combat narration strips impossible roll placeholders', () => {
  assert.match(serverJs, /cleanInvalidCombatNarration/, 'server should sanitize impossible combat placeholder text before emitting DM narration');
  assert.match(narrationPipelineJs, /cleanInvalidCombatNarration\(parsed\.narration\)/, 'split narration pipeline should sanitize final streamed narration before display');
  assert.match(serverJs, /Do NOT add HIT\/MISS to non-damage/, 'combat prompt should forbid HIT/MISS formatting for non-damage results');
});

test('character sheet exposes editable persisted combat math profiles', () => {
  assert.match(gameHtml, /id="c-combat-math"/, 'character sheet should include combat math profile editor');
  assert.match(gameHtml, /function renderCombatMathProfiles/, 'client should render derived attack profiles');
  assert.match(gameHtml, /function collectCombatMathProfiles/, 'client should collect profile edits on save');
  assert.match(gameHtml, /combatProfiles: collectCombatMathProfiles\(\)/, 'character save should send edited combat profiles');
  assert.match(serverJs, /normalizeDnd5eCombatStats/, 'server should normalize and persist combat math profiles');
  assert.match(serverJs, /applyCombatProfileEdits/, 'server should merge player-edited attack math into combatStats');
});

test('enemy turns normalize decisions into executable combat engine actions', () => {
  assert.match(serverJs, /map\(a => a\.label \|\| a\.name \|\| a\.type\)/, 'enemy tactics prompt should list real action labels');
  assert.match(serverJs, /function normalizeEnemyActionType/, 'enemy tactic action words should be normalized before engine resolution');
  assert.match(serverJs, /actorId: current\.id/, 'non-attack enemy actions should include actorId for the combat engine');
});

test('combat turn order shows timed concentration effects', () => {
  assert.match(serverJs, /getDisplayInitiativeOrder\(\)/, 'server should publish display initiative including concentration effect rows');
  assert.match(gameHtml, /entry\.type === 'Effect'/, 'turn order renderer should handle effect rows without combatant HP');
  assert.match(gameHtml, /remainingTurns/, 'effect rows should show remaining turn count');
  assert.match(gameHtml, /typeof rawEntry === 'string'/, 'turn order renderer should tolerate older string initiative rows');
  assert.match(gameHtml, /combatants\[entry\.id\] \|\| entry/, 'turn order renderer should still show rows when HP data is missing');
  assert.match(serverJs, /processStart: false, processEnd: false/, 'enemy decision planning should not fire ongoing effects speculatively');
  assert.match(serverJs, /activeEffects: JSON\.parse\(JSON\.stringify/, 'enemy decision planning should restore active effect timers before execution');
  assert.match(gameHtml, /combatState = \{[\s\S]*initiativeOrder: data\.initiativeOrder \|\| combatState\?\.initiativeOrder/, 'combat updates should preserve the last valid initiative order');
  assert.match(gameHtml, /if \(!rendered\) \{[\s\S]*showPartyTurnOrder\(\);/, 'empty combat order should visibly fall back instead of showing a blank panel');
});

test('combat freeform actions are not silently converted into weapon attacks', () => {
  assert.doesNotMatch(serverJs, /Default:\s*attack the first living enemy with primary weapon/, 'server combat path should not coerce unknown player actions into attacks');
  assert.doesNotMatch(gameEngineJs, /Default:\s*attack the first living enemy with primary weapon/, 'game-engine combat path should not coerce unknown player actions into attacks');
});

test('GM prompt keeps attack rolls under server control', () => {
  assert.match(promptBuilderJs, /Outside active combat, do not roll attack dice/, 'GM prompt should forbid model-rolled attacks outside active combat');
  assert.match(promptBuilderJs, /let the server resolve the attack on the next combat turn/, 'GM prompt should route new violence into server combat resolution');
  assert.doesNotMatch(promptBuilderJs, /Combine attack roll \+ damage \+ result on ONE line/, 'old model-rolled attack style should not remain in the main prompt');
  assert.doesNotMatch(serverJs, /Kael swings longsword \(STR \+3, Prof \+2\) — rolls 17/, 'legacy few-shot should not teach model-resolved attacks');
});

test('non-combat scenes do not keep hostile suggested options', () => {
  assert.match(serverJs, /function looksLikeHostileOption/, 'server should classify hostile suggested options');
  assert.match(serverJs, /function filterOptionsForSceneState/, 'server should filter options against current scene state');
  assert.match(serverJs, /optionsFilteredForScene/, 'filtered options should be traceable in dm_message diagnostics');
  assert.match(serverJs, /filterOptionsForSceneState\(messageData\.options, gs, messageData\.text \|\| ''\)/, 'dm messages should filter stale hostile options before saving them');
});

test('non-combat scenes suppress AI-generated narrative option buttons', () => {
  assert.match(serverJs, /function suppressNonCombatSceneOptions/, 'server should centralize non-combat option suppression');
  assert.match(serverJs, /optionsSuppressedForSceneInput: true/, 'suppressed scene options should be traceable in dm_message diagnostics');
  assert.match(serverJs, /!gs\.combatEngine\?\.state\?\.active/, 'scene option suppression should only apply outside active combat');
  assert.match(serverJs, /gs\.lastOptions = \[\]/, 'suppressed scene options should not persist for reconnect');
});

test('combat narration cannot claim an engine target died early', () => {
  assert.match(serverJs, /Do NOT narrate a target as dead, defeated, motionless, or finished/, 'combat prompt should forbid premature kill narration');
  assert.match(serverJs, /unless RESOLVED THIS ROUND explicitly says its HP reached 0 or COMBAT IS OVER is present/, 'premature kill guard should tie death language to engine state');
});

test('combat turn options stay scoped to the engine turn after actions and auto-actions', () => {
  assert.match(serverJs, /function getVisiblePlayerForOptions/, 'server should compute option owner from active combat engine turn');
  assert.match(serverJs, /const nextPlayer = getVisiblePlayerForOptions\(gameId\);[\s\S]*emitDmMessage\(gameId, \{ text: narration, options, auto: false/, 'human combat actions should emit options for the resolved engine turn');
  assert.match(serverJs, /const nextPlayer = getVisiblePlayerForOptions\(gameId\);[\s\S]*emitDmMessage\(gameId, \{ text: narration, options, auto: true/, 'auto combat actions should emit options for the resolved engine turn');
});

test('combat start clears stale scene options', () => {
  assert.match(gameHtml, /function clearPendingOptions\(\)/, 'client should centralize stale option clearing');
  assert.match(gameHtml, /socket\.on\('combat_started'[\s\S]*?clearPendingOptions\(\)/, 'combat start should remove pre-combat social options from the action area');
  assert.match(gameHtml, /NO OPTIONS in model response[\s\S]*?pendingOptions = \[\]/, 'messages with no options should clear pending client options');
  assert.match(serverJs, /hasOwnProperty\.call\(messageData \|\| \{\}, 'options'\)[\s\S]*?gs\.lastOptions = \[\]/, 'server should clear remembered options when emitting an explicit empty options array');
});

test('combat end clears stale targets and hides combat-only quick actions', () => {
  assert.match(gameHtml, /socket\.on\('combat_ended'[\s\S]*?combatState = \{ active: false, combatants: \{\}, initiativeOrder: \[\], targetSuggestions: \{\} \}/, 'client should clear defeated combatants after combat ends');
  assert.match(gameHtml, /targetPreferences = \{\}/, 'client should clear stale combat target preferences after combat ends');
  assert.match(gameHtml, /function isCombatOnlyActionChip/, 'client should classify combat-only action chips');
  assert.match(gameHtml, /filter\(chip => combatActive \|\| !isCombatOnlyActionChip/, 'client should hide aggressive/tactical chips outside active combat');
});

test('combat auto-actions are resolved by the combat engine', () => {
  assert.match(serverJs, /function chooseCombatAutoAction/, 'server should choose a concrete combat action for timed-out PCs');
  assert.match(serverJs, /callGameLLM\(gameId, gameConfig, gs\.combatEngine\?\.state\?\.active \? `\$\{playerName\}: \$\{autoAction\}` : autoAction/, 'combat auto-actions should be sent as parseable player actions');
  assert.match(serverJs, /gs\.combatEngine\.getCurrentTurn\(\)\?\.type === 'Enemy'[\s\S]*await resolveEnemyTurns/, 'turn advancement should not skip an enemy if combat is parked on an enemy turn');
});

test('enemy combat turns are deterministic by default', () => {
  assert.match(serverJs, /function chooseDeterministicEnemyDecision/, 'server should have deterministic enemy tactics');
  assert.match(serverJs, /process\.env\.ENEMY_TACTICS_LLM === 'true'/, 'enemy tactic LLM calls should be opt-in');
  assert.match(serverJs, /if \(process\.env\.ENEMY_TACTICS_LLM !== 'true'\)[\s\S]*?chooseDeterministicEnemyDecision/, 'default enemy turns should skip LLM tactics');
});

test('enemy turns retarget stale precomputed decisions before resolving attacks', () => {
  assert.match(serverJs, /require\('\.\/enemy-targeting'\)/, 'server should use shared enemy targeting helpers');
  assert.match(serverJs, /resolveEnemyDecisionTarget\(decision\?\.targetId, pcs\)/, 'server should refresh stale precomputed targets against currently living PCs');
});

test('parseable combat actions use a deterministic tactical fast path', () => {
  assert.match(serverJs, /async function tryResolveCombatActionFastPath/, 'server should have a deterministic combat action fast path');
  assert.match(serverJs, /tryResolveCombatActionFastPath\(gameId, gameConfig, playerName, action\)/, 'player_action should try the fast path before calling the narration LLM');
  assert.match(serverJs, /if \(combatFastPath\?\.handled\)[\s\S]*?tactical: true/, 'fast path should emit tactical DM messages instead of streamed narration');
  assert.match(serverJs, /if \(!combatFastPath\.blocked\) \{[\s\S]*?await advanceTurn\(gameId, gameConfig, true\);/, 'target prompts should not advance the turn');
  assert.match(serverJs, /target_required/, 'target-required results should be handled explicitly');
});

test('combat LLM fallback returns tactical engine text instead of re-narrating resolved rolls', () => {
  assert.match(serverJs, /let combatTacticalReturn = null/, 'combat fallback should be able to short-circuit after engine resolution');
  assert.match(serverJs, /combatTacticalReturn = \{[\s\S]*?narration: text,[\s\S]*?llmRunId: null,[\s\S]*?\}/, 'resolved combat fallback should build a no-LLM tactical response');
  assert.match(serverJs, /if \(combatTacticalReturn\) return combatTacticalReturn;[\s\S]*?const combatPromptInjection/, 'server should not call the narration model after tactical combat is already resolved');
});

test('combat target preferences have a client/server socket contract', () => {
  assert.match(gameHtml, /id="target-control-row"/, 'combat controls should include persistent target selectors');
  assert.match(gameHtml, /id="attack-target-select"/, 'attack target selector should exist');
  assert.match(gameHtml, /id="support-target-select"/, 'support target selector should exist');
  assert.match(gameHtml, /socket\.emit\('set_target_preferences'/, 'client should persist target preference changes');
  assert.match(gameHtml, /if \(combatActive\) payload\.targetPreferences = getSelectedTargetPreferences\(\)/, 'player actions should only carry selected targets during active combat');
  assert.match(serverJs, /socket\.on\('set_target_preferences'/, 'server should persist target preference changes');
  assert.match(serverJs, /targetPreferences/, 'combat socket payloads should include target preferences');
});

test('untargeted offensive actions ask for a target before resolution', () => {
  assert.match(serverJs, /function isUntargetedOffensiveAction/, 'server should detect offensive actions without valid targets');
  assert.match(serverJs, /function targetRequiredNarration/, 'server should have a deterministic target prompt');
  assert.match(serverJs, /isUntargetedOffensiveAction\(userMessage[\s\S]*?return targetRequiredNarration\(userMessage\)/, 'inactive combat LLM calls should prompt before resolving untargeted attacks');
  assert.match(serverJs, /const nextPlayer = blocked \? playerName : getVisiblePlayerForOptions/, 'target prompts should keep the same player turn');
});

test('verbose campaign helper does not treat old combat log text as active combat', () => {
  assert.match(campaignVerboseTs, /__ttsCombatActive/, 'live smoke helper should read the explicit combat-active flag');
  assert.doesNotMatch(campaignVerboseTs, /combatLog\?\.textContent\?\.includes\('Combat Begins'\)/, 'stale combat log text should not trigger combat fallback actions');
});

test('verbose campaign transcript prints selected player actions', () => {
  assert.match(campaignVerboseTs, /let actionDescription = ''/, 'campaign transcript should track the selected action text');
  assert.match(campaignVerboseTs, /PLAYER ACTION:/, 'campaign transcript should print the selected action before the DM response');
});

test('verbose campaign fallback actions consume named leads instead of re-asking clerks', () => {
  assert.match(campaignVerboseTs, /go directly to Harl Venn at the south warehouse quay/i, 'smoke player should consume the Harl Venn lead');
  assert.match(campaignVerboseTs, /go directly to Warehouse 12/i, 'smoke player should consume the Warehouse 12 lead');
  assert.match(campaignVerboseTs, /go directly to the shuttered counting-house on Wharf Lane/i, 'smoke player should consume the Wharf Lane counting-house lead');
  assert.match(campaignVerboseTs, /go directly to the cooper's shed/i, 'smoke player should consume the cooper shed lead');
  assert.match(campaignVerboseTs, /cut off the green-gloved thug/i, 'smoke player should push visible danger into a scene');
  assert.match(campaignVerboseTs, /confront the factor with the orderbook/i, 'smoke player should force evidence scenes to pay off');
  assert.match(campaignVerboseTs, /private lift key to tonight's handoff/i, 'smoke player should follow scheduled handoff stakes');
  assert.match(campaignVerboseTs, /confront Harrow Quill/i, 'smoke player should force named climax targets');
  assert.match(campaignVerboseTs, /force the buyer's identity/i, 'smoke player should force merchant-house breadcrumb chains to close');
  assert.doesNotMatch(campaignVerboseTs, /Ask what the clerk needs from us/, 'smoke player should not keep re-asking clerks after a lead is visible');
});

test('host recovery and optional combat compression are explicit controls', () => {
  assert.match(gameHtml, /Move to Next Beat/, 'reset affordance should become Move to Next Beat');
  assert.match(gameHtml, /socket\.emit\('move_to_next_beat'/, 'client should request story-beat recovery explicitly');
  assert.match(serverJs, /socket\.on\('move_to_next_beat'/, 'server should handle story-beat recovery');
  assert.match(gameHtml, /id="btn-finish-cinematic"/, 'combat UI should expose Finish Cinematically');
  assert.match(gameHtml, /socket\.emit\('finish_cinematic'/, 'client should propose cinematic combat finish');
  assert.match(serverJs, /socket\.on\('finish_cinematic'/, 'server should handle cinematic finish proposals');
});

test('offensive actions against named threats start engine combat before narration resolution', () => {
  assert.match(serverJs, /function maybeStartCombatFromOffensiveAction/, 'server should detect attacks against named threats when combat is not active');
  assert.match(serverJs, /extractNamedCombatTarget\(userMessage/, 'pre-combat detection should use the submitted player action');
  assert.match(serverJs, /if \(started\) return legacyCallLLM\(gameId, gameConfig, userMessage, actingAs\);/, 'legacy path should restart in combat mode after creating a custom threat');
  assert.match(serverJs, /await initiateCombat\(gameId, gameConfig, parsed\.world\.enemies\)/, 'formal enemy blocks should be awaited before the turn advances');
  assert.match(serverJs, /slug: 'custom'[\s\S]*hint: targetName/, 'named targets should become custom enemies with generation hints');
});

test('combat narration cannot move the map to a new chamber', () => {
  assert.match(serverJs, /const combatMapLocked = combatActive && gs\.combatEngine\?\.state\?\.active;/, 'server should detect active combat before map processing');
  assert.match(serverJs, /combatMapLocked\s*\?\s*\{ moved: false/, 'server should suppress map movement while combat is active');
  assert.match(gameEngineJs, /const combatMapLocked = combatActive && gs\.combatEngine\?\.state\?\.active;/, 'game engine should detect active combat before map processing');
  assert.match(gameEngineJs, /combatMapLocked\s*\?\s*\{ moved: false/, 'game engine should suppress map movement while combat is active');
});

test('character action and spell chips are compact on action controls', () => {
  assert.match(gameHtml, /id="character-action-chips"/, 'action controls should include a character action chip rail');
  assert.match(gameHtml, /function buildCharacterActionChips/, 'client should build chips from standard actions and spells');
  assert.match(gameHtml, /splitActionList\(char\.standardActions\)/, 'standardActions should feed action chips');
  assert.match(gameHtml, /char\.combatStats\?\.spells/, 'configured spells should feed spell chips');
  assert.match(gameHtml, /max-height: 30px;/, 'mobile chip rail should show one row');
  assert.match(gameHtml, /max-height: 60px;|max-height: 64px;/, 'larger screens should allow two rows');
});

test('Tune GM exposes only actionable feedback and creates traceable bug reports', () => {
  assert.match(gameHtml, /\['review', 'Review'\]/, 'Tune GM should expose a Review tag');
  assert.match(gameHtml, /\['redo_options', 'Redo Options'\]/, 'Tune GM should expose a Redo Options tag');
  assert.match(gameHtml, /\['retcon', 'Retcon'\]/, 'Tune GM should expose a Retcon tag');
  assert.doesNotMatch(gameHtml, /\['great_moment', 'Great'\]/, 'non-actionable praise feedback should be removed');
  assert.doesNotMatch(gameHtml, /feedback-score/, 'star ratings should not be rendered');
  assert.match(serverJs, /'rules_wrong', 'forgot_context', 'review', 'retcon', 'redo_options'/, 'server should accept actionable feedback tags');
  assert.match(serverJs, /function selfAssessAndMaybeLogBug/, 'server should self-assess actionable feedback');
  assert.match(serverJs, /decisionTrace/, 'review bugs should include a decision trace');
  assert.match(serverJs, /db\.saveBugReport\([\s\S]*?\{ slug, decisionTrace, source \}/, 'feedback should push trace metadata into bug reports');
});

test('Retcon feedback arms the next action as OOC', () => {
  assert.match(gameHtml, /id="ooc-mode-indicator"/, 'action controls should include a visible OOC indicator');
  assert.match(gameHtml, /function setOocMode\(active/, 'client should centralize OOC mode visuals');
  assert.match(gameHtml, /tag === 'retcon'[\s\S]*?setOocMode\(true/, 'Retcon should arm OOC mode');
  assert.match(gameHtml, /input\.dataset\.oocMode === 'true'[\s\S]*?sendOOC/, 'armed OOC mode should send the next text as OOC');
});

test('Redo Options feedback regenerates options and logs a decision trace', () => {
  assert.match(gameHtml, /socket\.emit\('redo_options'/, 'Redo Options should ask the server for replacements');
  assert.match(gameHtml, /socket\.on\('options_redone'/, 'client should render regenerated options');
  assert.match(serverJs, /socket\.on\('redo_options'/, 'server should handle option regeneration');
  assert.match(serverJs, /source: 'redo_options'/, 'redo options should force a traceable bug source');
  assert.match(serverJs, /Regenerate exactly 3 scene-specific player options/, 'replacement options should be scene-specific');
});

test('non-hostile and progress intent cannot auto-derail into combat', () => {
  assert.match(serverJs, /function hasNonHostileProgressIntent/, 'server should detect dialogue/progress intent');
  assert.match(serverJs, /function hasHardCombatSignal/, 'server should centralize hard combat signals');
  assert.match(serverJs, /intent-guard[\s\S]*?Suppressed ENEMIES block/, 'formal enemy blocks should be suppressible after non-hostile input');
  assert.doesNotMatch(serverJs, /emerge\|appear\|surround\|block\|engage/, 'soft scene text should not be hard combat signal terms');
  assert.match(promptBuilderJs, /Merchant, guard, watch, checkpoint/, 'prompt should preserve merchant/checkpoint scenes as social routing beats');
});

test('formal enemy blocks require an actual hostile trigger', () => {
  assert.match(actionParserJs, /function isExplicitHostileAction/, 'parser should expose a narrow hostile-action predicate');
  assert.match(serverJs, /const explicitHostileAction = hasExplicitHostileAction\(userMessage\)/, 'server should inspect submitted action before accepting ENEMIES blocks');
  assert.match(serverJs, /if \(nonHostileProgressIntent && !explicitHostileAction\)/, 'formal enemy blocks should not start combat after non-hostile player intent');
  assert.match(narrationPipelineJs, /explicitHostileAction \|\| \(!nonHostileIntent && hasHardCombatSignal/, 'split pipeline should use the same non-hostile intent gate');
});

test('legacy narration path replaces low-information action echoes', () => {
  assert.match(narrationPipelineJs, /function isLowInformationNarration/, 'pipeline should centralize low-information narration detection');
  assert.match(narrationPipelineJs, /function buildFallbackTurn/, 'pipeline should centralize playable fallback narration');
  assert.match(serverJs, /isLowInformationNarration\(parsed\.narration, submittedActionText\)/, 'legacy path should detect action echoes after parsing model output');
  assert.match(serverJs, /buildFallbackTurn\(fallbackActor, submittedActionText\)/, 'legacy path should replace echoes with playable fallback narration');
});

test('legacy narration path injects anti-stall objective closure', () => {
  assert.match(narrationPipelineJs, /buildAntiStallPacingDirective/, 'pipeline should expose anti-stall pacing');
  assert.match(serverJs, /buildAntiStallPacingDirective\(gd\.chatHistory, submittedActionTextForPrompt\)/, 'legacy path should add the same anti-stall pacing as split narration');
  assert.match(serverJs, /function buildObjectiveClosureDirective/, 'legacy path should add a stronger late-objective closure guard');
  assert.match(serverJs, /Do not send the party to another office, annex, room, clerk, signatory, meeting, quay, crane, lane, route, exchange, back gate, route code, escort sign, cargo prayer, or "within the hour" lead/, 'closure guard should ban the observed breadcrumb endings');
  assert.match(serverJs, /Do not end with someone merely escaping, vanishing deeper, still within reach, "not alone", holding "real leverage", being moved tonight, a crew that "has names", or proof still being kicked into danger/, 'closure guard should ban chase-deferral endings');
});

test('legacy narration path repairs deferred payoff endings after anti-stall turns', () => {
  assert.match(serverJs, /function isDeferredPayoffNarration/, 'server should detect narrations that defer payoff into another chase beat');
  assert.match(serverJs, /function hasUnsupportedNonCombatDamageNarration/, 'server should detect pseudo-combat injury outside active combat');
  assert.match(serverJs, /function isLeadLadderNarration/, 'server should detect late boss-above-boss escalation loops');
  assert.match(serverJs, /function buildPayoffClosureFallback/, 'server should have a deterministic fallback when repair cannot land the payoff');
  assert.match(serverJs, /function repairDeferredPayoffNarration/, 'server should have a focused repair pass for deferred payoff narration');
  assert.match(serverJs, /task: 'narration-payoff-repair'/, 'repair pass should be traceable in LLM telemetry');
  assert.match(serverJs, /isDeferredPayoffNarration\(parsed\.narration, submittedActionText, gd\.chatHistory\)[\s\S]*isLeadLadderNarration\(parsed\.narration, submittedActionText, gd\.chatHistory\)[\s\S]*hasUnsupportedNonCombatDamageNarration\(parsed\.narration, submittedActionText\)/, 'legacy path should inspect parsed narration before saving it');
  assert.match(serverJs, /parsed\.narration = repairedNarration/, 'successful repair should replace the deferred narration');
  assert.match(serverJs, /parsed\.narration = buildPayoffClosureFallback/, 'failed repair should fall back to a deterministic closure');
  assert.match(serverJs, /The chase stops here/, 'deterministic closure should explicitly stop the breadcrumb chain');
  assert.match(serverJs, /Do not add a new route, office, lane, contact, buyer, alias, or "next lead"/, 'repair prompt should forbid creating another breadcrumb');
  assert.match(serverJs, /Do not replace the current culprit with a higher authority to chase/, 'repair prompt should prevent boss-above-boss escalation');
  assert.match(serverJs, /Outside active combat, do not narrate NPCs hitting, wounding, drawing blood, or damaging PCs/, 'repair prompt should prevent non-engine damage narration');
  assert.match(serverJs, /flees\?\|fleeing\|fled/, 'repair detector should catch flee-forward endings');
  assert.match(serverJs, /being \(\?:moved\|shifted\)/, 'repair detector should catch moved-tonight cache endings');
  assert.match(serverJs, /crew has names/, 'repair detector should catch named-crew breadcrumbs');
  assert.match(serverJs, /kicks\?\.\{0,80\}\(\?:toward\|into\|over\|off\)/, 'repair detector should catch proof kicked into danger');
  assert.match(serverJs, /destroying records/, 'repair detector should catch destroy-the-records breadcrumbs');
  assert.match(serverJs, /berth \(\?:mark\|number\|seven\)/, 'repair detector should catch berth-mark breadcrumbs');
  assert.match(serverJs, /fresh lead/, 'repair detector should catch fresh-lead breadcrumbs');
  assert.match(serverJs, /route office/, 'repair detector should catch route-office breadcrumbs');
  assert.match(serverJs, /riverfront exchange/, 'repair detector should catch riverfront-exchange breadcrumbs');
  assert.match(serverJs, /escort sign/, 'repair detector should catch escort-sign breadcrumbs');
  assert.match(serverJs, /cargo prayer/, 'repair detector should catch cargo-prayer breadcrumbs');
  assert.match(serverJs, /assistantMessages\.length < 4/, 'lead ladder detector should trigger before the transcript drags');
  assert.match(serverJs, /function shouldUseDeterministicPayoffClosure/, 'late breadcrumb chains should bypass another LLM repair attempt');
  assert.match(serverJs, /const useDeterministicClosure = shouldUseDeterministicPayoffClosure/, 'legacy path should force deterministic closure for mature breadcrumb chains');
  assert.match(serverJs, /Do not end with the scene still mid-action/, 'repair prompt should force late scenes to land an outcome');
  assert.match(serverJs, /function isRepeatedRecentNarration/, 'server should reject verbatim repeated narration before it reaches players');
  assert.match(serverJs, /narration-repeat-guard/, 'repeated narration replacements should be traceable in logs');
  assert.match(serverJs, /initiative starts\?/, 'noncombat damage guard should catch AI-only initiative starts');
  assert.match(serverJs, /slices\?/, 'noncombat damage guard should catch pseudo-damage from blades outside engine combat');
  assert.match(serverJs, /Do not start combat, call for initiative, or narrate attacks unless the player explicitly chose violence/, 'payoff repair should not preserve AI-only combat after non-hostile input');
});

test('story prompt discourages repeated gatekeeper loops and noncombat filler actions', () => {
  assert.match(promptBuilderJs, /Maintain one current objective at a time/, 'prompt should preserve a single active objective');
  assert.match(promptBuilderJs, /Maintain one active named lead, contact, or destination at a time/, 'prompt should preserve one active named lead');
  assert.match(promptBuilderJs, /do not invent a replacement contact or alternate destination/, 'prompt should not rotate contacts every turn');
  assert.match(promptBuilderJs, /If you need a twist, twist the current lead/, 'prompt should complicate the current lead instead of replacing it');
  assert.match(promptBuilderJs, /do not introduce another clerk, factor, outpost, or DC check/, 'prompt should avoid repeated guild checkpoint loops');
  assert.match(promptBuilderJs, /Minor routing\/social scenes have a two-response ceiling/, 'prompt should cap minor routing scenes before they drag');
  assert.match(promptBuilderJs, /the next progress action must consume that lead now/, 'prompt should consume already-established leads instead of restating them');
  assert.match(promptBuilderJs, /Begin each response after the latest DM message/, 'prompt should prevent rephrasing the latest narration');
  assert.match(promptBuilderJs, /Make utilitarian hooks feel alive quickly/, 'prompt should demand dramatic stakes for paperwork-style scenes');
  assert.match(promptBuilderJs, /Routine routing\/social scenes should resolve in one exchange and then advance/, 'prompt should move brief social scenes forward');
  assert.match(promptBuilderJs, /Never answer progress with only cautious movement and no new information/, 'prompt should not turn progress into cautious non-events');
  assert.match(promptBuilderJs, /ground the scene immediately with a named place/, 'generic openings should become concrete scenes');
  assert.match(promptBuilderJs, /Roll only when there is real uncertainty, meaningful consequence/, 'prompt should reserve rolls for meaningful uncertainty');
  assert.match(promptBuilderJs, /already-earned passage should advance without a check/, 'prompt should not block earned progress with extra checks');
  assert.match(promptBuilderJs, /Avoid Dodge, Disengage, Dash, or generic Attack fillers unless immediate physical danger is present/, 'noncombat options should not be tactical filler');
  assert.doesNotMatch(promptBuilderJs, /MOST character actions/, 'prompt should not demand procedural checks for most actions');
  assert.doesNotMatch(promptBuilderJs, /at minimum every other action/, 'prompt should not force rolls every other turn');
});

test('split narration prompt carries story momentum and option quality rules', () => {
  assert.match(narrationPipelineJs, /Every non-combat response must materially change the situation/, 'split narration should require changed situations');
  assert.match(narrationPipelineJs, /topLevelHistory\.length \? topLevelHistory : dataHistory/, 'split narration should read persisted chat history');
  assert.match(narrationPipelineJs, /Treat RECENT HISTORY as binding continuity/, 'split narration should preserve named leads from recent history');
  assert.match(narrationPipelineJs, /ANTI-STALL PACING/, 'split narration should inject anti-stall directives for repeated lead loops');
  assert.match(narrationPipelineJs, /Resolve or complicate it NOW/, 'anti-stall directives should force the established lead to be consumed');
  assert.match(narrationPipelineJs, /Minor routing\/social scenes have a two-response ceiling/, 'split narration should cap minor routing scenes before they drag');
  assert.match(narrationPipelineJs, /Begin each response after the latest DM message/, 'split narration should prevent repeated DM paragraphs');
  assert.match(narrationPipelineJs, /Never answer progress with only cautious movement and no new information/, 'split narration should avoid cautious non-event loops');
  assert.match(narrationPipelineJs, /Do not repeat the same beat from recent turns/, 'split narration should avoid repeated scouting beats');
  assert.match(narrationPipelineJs, /Each option must change the situation/, 'split narration options should be scene-changing');
  assert.match(narrationPipelineJs, /Avoid "inspect\/search\/scout ahead" unless a specific unresolved hazard/, 'split narration should avoid repeated passive inspection options');
  assert.match(serverJs, /Each option must materially change the situation/, 'server fallback option prompts should be scene-changing');
  assert.match(serverJs, /the direct advance option must consume it now/, 'server option fallback should avoid another travel-toward-the-lead option');
  assert.match(serverJs, /avoid repeated inspect\/watch\/scout options unless a specific unresolved hazard is visible/i, 'redo/fallback options should avoid passive re-check loops');
});

test('planned combat pacing does not force initiative by itself', () => {
  assert.match(encounterDirectorJs, /clear choice, not automatic initiative/, 'combat pacing should introduce a threat choice first');
  assert.match(encounterDirectorJs, /Only output an ENEMIES block if the player clearly chooses violence/, 'combat pacing should preserve player agency');
  assert.match(encounterDirectorJs, /guidance, not a scripted encounter/, 'sandbox encounter pacing should be soft guidance');
  assert.match(encounterDirectorJs, /Do not introduce unrelated monsters/, 'sandbox pacing should preserve current story context');
  assert.doesNotMatch(encounterDirectorJs, /Include this ENEMIES block in ---WORLD--- exactly/, 'director should not inject automatic combat blocks');
  assert.doesNotMatch(serverJs, /Forcing planned combat after pacing limit/, 'server should not force planned combat directly from pacing');
});

test('encounter planner is host-only and supports queued adventuring days', () => {
  assert.match(gameHtml, /data-host-only="planner"/, 'planner panel should be tagged host-only');
  assert.match(gameHtml, /id="btn-plan-next-day"/, 'host should have a control to queue the next adventuring day');
  assert.match(gameHtml, /function setHostVisibility\(isHost\)/, 'client should hide host-only planner UI for non-host players');
  assert.match(serverJs, /function hostRoom\(gameId\)/, 'server should define a private host room for planner updates');
  assert.match(serverJs, /socket\.join\(hostRoom\(gameId\)\)/, 'host sockets should join the host-only room');
  assert.match(serverJs, /function ensureHostSocket/, 'server should centralize host authorization for planner events');
  assert.match(serverJs, /socket\.on\('planner:plan_next_day'/, 'server should support queueing the next adventuring day');
  assert.match(serverJs, /db\.setState\(gameId, 'encounterPlan'/, 'planner state should be persisted');
  assert.match(serverJs, /io\.to\(hostRoom\(gameId\)\)\.emit\('encounter_plan_updated'/, 'planner updates should not be broadcast to all players');
});

test('cost endpoint reads cost history through the tracker API', () => {
  assert.match(serverJs, /getCostLog/, 'server should import the exported cost log accessor');
  assert.match(serverJs, /app\.get\('\/api\/costs'[\s\S]*?const costLog = getCostLog\(\)/, 'cost endpoint should not reference an unscoped costLog variable');
});
