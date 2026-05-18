'use strict';

const templateEngine = require('./template-engine');
const { formatPlanForPrompt } = require('./encounter-designer');
const llm = require('./llm');
const { worldExtractionSchema, validationSchema } = require('./llm/schemas/world-extraction');
const { isDialogueAction, isAdvanceAction, isExplicitHostileAction } = require('./action-parser');
const { cleanInvalidCombatNarration } = require('./narration-sanitizer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERBOSITY_RULES = {
  verbose: 'Write ~100 words of narration. Vivid detail and atmosphere.',
  brief:   'BRIEF MODE — HARD LIMIT: 75 words max narration. 4-5 sentences. Punchy and direct.',
  terse:   'TERSE MODE — ABSOLUTE LIMIT: 50 words max. 3 sentences max. No atmosphere, no descriptions, no internal thoughts. State what happens mechanically. Count your words. If you write more than 50 words, you have failed.',
};

const STORY_MOMENTUM_RULES = [
  'Every non-combat response must materially change the situation: location, clue, NPC stance, danger, cost, route, or decision.',
  'Maintain one active named lead, contact, or destination until the party reaches, resolves, or clearly loses it.',
  'If you need a twist, twist the current lead instead of inventing a replacement contact, route, or destination.',
  'Begin each response after the latest DM message. Do not reproduce or paraphrase any full sentence from recent history.',
  'Do not end by only pointing to the next lead; pay known leads off as arrival, confrontation, revelation, cost, or hard choice.',
  'A strong non-combat turn has payoff, pressure, and visible change.',
  'Confront/demand answers is social unless explicit attack/damaging spell.',
  'Never repeat a prior clue as the main event; recap old evidence in one short phrase, then show the new consequence.',
  'Late objectives cannot end on "the witness is trying to say a name", "the papers are burning", "the culprit is below", footsteps, or another tunnel; resolve proof, culprit, or cost.',
  'For travel, progress, acknowledgement, and "move on" actions, move the party to the next concrete place, person, clue, or decision.',
  'Never describe a non-empty travel, progress, or clue-payoff action as "doing nothing" or "nothing useful"; partial intent moves forward.',
  'Minor routing/social scenes have a two-response ceiling: establish the lead, then reveal, resolve, complicate, or leave.',
  'If recent history already ended with "the next lead is ahead/one room away/waiting there", the next progress action must consume that lead now instead of restating that it is close.',
  'Never answer progress with only cautious movement and no new information. If the party checks for danger and there is no meaningful hazard, compress the caution and advance the scene.',
  'Do not repeat the same beat from recent turns; switch to arrival, discovery, dialogue, consequence, or choice.',
  'Merchant, guard, checkpoint, and passerby scenes are brief routing/social beats unless the player clearly chooses violence or a hard failure forces initiative.',
  'By the second response, expose motive, secret, threat, personality, or cost.',
].join('\n- ');

const OPTION_QUALITY_RULES = [
  'Each option must change the situation; avoid options that merely maintain safety, watch a flank, wait, or re-check the same path.',
  'Offer one direct advance option, one interaction/investigation option, and one bold or risky option.',
  'Name the current lead, NPC, location, clue, or visible danger when possible. Specific options beat generic verbs.',
  'Avoid "inspect/search/scout ahead" unless a specific unresolved hazard, clue, or mystery is visible right now.',
  'In social or travel scenes, options should favor dialogue, leverage, route choice, discovery, or decisive movement over combat defaults.',
].join('\n- ');

const FALLBACK_OPTIONS = [
  'Advance to the next clear lead',
  'Ask one pointed question about the current clue',
  'Take a bold risk that changes the situation',
];

const STRUCTURED_MARKER_PATTERN = String.raw`(?:-{3,}\s*(OPTIONS|SCENE|WORLD)\s*-{3,}?|#{1,3}\s*(OPTIONS?|SCENE|WORLD)\s*(?=\n|$))`;
const STREAM_MARKER_LOOKAHEAD = 60;

function hasHardCombatSignal(text) {
  const value = String(text || '').replace(/\b(?:not|no|never|without|isn't|wasn't|weren't)\s+(?:an?\s+)?(?:ambush|attack|fight|combat|trap|hostility|hostile)\b/gi, '');
  return /(?:roll(?:s|ing)?\s+(?:for\s+)?initiative|initiative.*(?:order|roll)|combat\s+(?:begins|starts|erupts|breaks out)|(?:goblin|orc|skeleton|zombie|wolf|rat|bandit|dragon|spider|kobold|gnoll|bugbear|hobgoblin|cultist|thug|guard|knight|wraith|ghoul|ghast|wight|vampire|demon|devil|elemental|giant|minotaur|owlbear|manticore|hydra|chimera|basilisk|beholder|lich|golem|treant|werewolf)s?\s+(?:attack|attacks|lunge|lunges|charge|charges|rush|rushes|swing|swings|slash|slashes|stab|stabs|strike|strikes|pounce|pounces|ambush|ambushes)\b|(?:attacks?\s+(?:you|the party|with)|charges?\s+(?:at|toward|into)|ambush(?:ed|es)?!?|lunges?\s+(?:at|toward)|strikes?\s+(?:at|with)|draws?\s+(?:its |their )?(?:sword|weapon|blade|axe|bow)|weapons?\s+drawn|swords?\s+(?:raised|drawn|flashing)|prepare(?:s)?\s+to\s+(?:fight|attack|strike)|openly\s+hostile|turns?\s+hostile|ready\s+(?:their|your)\s+weapons?))/i.test(value);
}

function createStructuredMarkerRegex(flags) {
  return new RegExp(STRUCTURED_MARKER_PATTERN, flags);
}

function buildFallbackTurn(characterName, actionText) {
  const rawActor = String(characterName || '').trim();
  const actor = rawActor && rawActor !== 'Unknown' && rawActor.length <= 40 && !/[.!?]/.test(rawActor)
    ? rawActor
    : 'The story';
  const action = String(actionText || '')
    .replace(/\[AUTO-ACTION[^\]]*\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const verb = actor === 'The story' ? 'moves forward' : 'follows through';
  const actionClause = action
    ? ` ${verb}: ${action}`
    : ' takes a cautious step forward';

  return {
    narration: `${actor}${actionClause}. The scene stays tense but playable as the party keeps its footing and watches for the next opening.`,
    options: [...FALLBACK_OPTIONS],
  };
}

function buildAntiStallPacingDirective(history, actionText) {
  const assistantMessages = (history || [])
    .filter(msg => msg?.role === 'assistant' && msg.content)
    .map(msg => String(msg.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-4);
  if (assistantMessages.length < 2) return '';

  const action = String(actionText || '');
  const playerIsTryingToMoveScene =
    isAdvanceAction(action) ||
    isDialogueAction(action) ||
    /\b(?:follow|continue|proceed|press on|move on|head|travel|enter|approach|leave|ask|explain|state|offer|cooperate|lead|objective|inspect|search|investigate|look|study|examine|check|trace|track)\b/i.test(action);
  if (!playerIsTryingToMoveScene) return '';

  const recent = assistantMessages.join(' ').toLowerCase();
  const stallSignals = [
    /\b(?:next|clear)\s+(?:lead|objective|proof|decision|place)\b/,
    /\b(?:one\s+(?:room|door)|door\s+away|room\s+away|waiting\s+(?:there|ahead|beyond)|waits?|bracing|ahead)\b/,
    /\b(?:points?|leads?|go(?:es)?)\s+(?:toward|to|back)\b/,
    /\b(?:clerk|guild|ledger|permit|docket|seal|factor|counting\s+room|warehouse|countinghouse)\b/,
    /\b(?:dockmaster|dock|quay|shipment|cargo|crate|manifest|freight|berth|shutter)\b/,
  ];
  const signalCount = stallSignals.reduce((count, pattern) => count + (pattern.test(recent) ? 1 : 0), 0);
  if (signalCount < 2) return '';

  return `[ANTI-STALL PACING]
Recent DM turns already established the current lead, destination, permission step, or document trail. If the player repeats non-hostile social, search, or progress intent, treat it as consent to proceed. Do not narrate another transition, reminder, reluctance, or "it is ahead/one door away" beat. Resolve or complicate it NOW in this response: change the physical location, arrive inside, reveal the proof, confront the responsible NPC, introduce immediate danger, extract a cost, or close the minor routing scene and move to the next materially different scene. Do not end this response by only naming another lead. This turn needs payoff, pressure, or a hard choice: put someone named on stage, expose motive, force a cost, start a valid threat, or close the objective. This objective has consumed several turns; if an accountable NPC, culprit, cache, handoff, or named place is visible, resolve or climax it now rather than adding another intermediary. Forbidden endings: "the next move is clear", "one more door", "the lead points to", "reach X before Y", "the witness is trying to say a name", "the papers are burning", "the culprit is below", "footsteps approach", "there is another tunnel", or a newly named contact with no immediate payoff. If this is a merchant/guild/clerk/permit/ledger scene and the player is cooperating or following the lead, wrap the scene up instead of adding another clerk or document.`;
}

function isClosedBeatAftermathAction(actionText) {
  const action = String(actionText || '');
  return isAdvanceAction(action) ||
    isGenericResolvedObjectiveAction(action) ||
    /\b(?:next story beat|move on|continue|press on|advance|leave|depart|head out|travel on|clue pays off|expose|demand|collect|concession|restitution|supplies|passage|make them pay|hold them accountable)\b/i.test(action);
}

function buildResolvedBeatAdvanceDirective(history, actionText) {
  const assistantMessages = (history || [])
    .filter(msg => msg?.role === 'assistant' && msg.content)
    .map(msg => String(msg.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const latest = assistantMessages[assistantMessages.length - 1] || '';
  if (!isClosedBeatAftermathAction(actionText)) return '';
  if (!hasRecentResolvedBeat(assistantMessages)) return '';
  if (isFreshBeatBoundary(latest)) return '';

  return `[RESOLVED BEAT ADVANCE]
The previous objective is done. Do not reopen the same culprit, guild, warehouse, ledger, cache, quay, stair, runner, buyer, or hidden room. Pay out the consequence in one sentence, then cut to a fresh materially different story beat tied to the party's larger objective.`;
}

function isFreshBeatBoundary(text) {
  return /\b(?:old ledger trail is behind you|this is a new problem|sealed roadside waystation|bell ringing|bell inside keeps ringing|ringing is coming from a mechanism|drag mark|rear hatch|wounded messenger|south-road|south road|loss site|wrecked milestone|collapsed culvert|clawed tracks|hidden den|scavenger beast|creature|mule bones|fresh footprints|shrine road|hooded courier|roadside chapel|thorn-choked|cracked altar|black-wax satchel|broken signet|hill shrine|vessa coil|obsidian bell|watchtower|current scene)\b/i.test(String(text || ''));
}

function isGenericResolvedObjectiveAction(actionText) {
  return /\b(?:named clue|person responsible|current lead|clue pays off|force the current lead|confrontation now|decisive move.*answers|risk.*answers|put .* clue)\b/i.test(String(actionText || ''));
}

function reopensClosedGuildObjective(text) {
  return /\b(?:guild|ledger|dock row|counting-house|countinghouse|merrow|sella|sarn|brannic|signet|crate|crates|buyer|quay|warehouse|clerk|factor|vouchers|routed crates|restitution)\b/i.test(String(text || ''));
}

function hasRecentResolvedBeat(assistantHistory) {
  return (assistantHistory || [])
    .slice(-6)
    .some(msg => /\bThis beat is resolved\b|\btruth no longer moves to another room\b|\bold guild lead stays closed\b|\bold ledger trail is behind you\b|\bguild matter closes instead of reopening\b/i.test(msg || ''));
}

function buildFreshBeatStaleActionDirective(history, actionText) {
  const assistantMessages = (history || [])
    .filter(msg => msg?.role === 'assistant' && msg.content)
    .map(msg => String(msg.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const latest = assistantMessages[assistantMessages.length - 1] || '';
  if (!isFreshBeatBoundary(latest)) return '';
  if (!isGenericResolvedObjectiveAction(actionText)) return '';

  return `[CURRENT SCENE GUARD]
The prior guild/ledger objective is closed and must stay closed. The player's generic clue/confrontation phrasing now applies to the current scene only. Continue from the sealed waystation, bell mechanism, drag marks, messenger, rear hatch, or other current-scene evidence. Do not return to Dock Row, Sella, Merrow, Brannic, guild ledgers, crates, buyers, restitution, or passage vouchers.`;
}

function normalizeBareNarration(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim()
    .toLowerCase();
}

function getCurrentChatHistory(gs) {
  const topLevelHistory = Array.isArray(gs?.chatHistory) ? gs.chatHistory : [];
  const dataHistory = Array.isArray(gs?.data?.chatHistory) ? gs.data.chatHistory : [];
  if (!topLevelHistory.length) return dataHistory;
  if (!dataHistory.length) return topLevelHistory;
  return dataHistory.length >= topLevelHistory.length ? dataHistory : topLevelHistory;
}

function isLowInformationNarration(narration, actionText = '') {
  const normalized = normalizeBareNarration(narration);
  if (!normalized) return true;

  const action = normalizeBareNarration(actionText);
  if (action && normalized === action) return true;

  return FALLBACK_OPTIONS
    .map(normalizeBareNarration)
    .includes(normalized);
}

function getAssistantHistory(gs) {
  return getCurrentChatHistory(gs)
    .filter(msg => msg?.role === 'assistant' && msg.content)
    .map(msg => String(msg.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isPayoffSeekingAction(actionText) {
  const action = String(actionText || '');
  return isDialogueAction(action) || isAdvanceAction(action) ||
    /\b(?:lead|clue|proof|answer|answers|confront|decisive|responsible|payoff|force|expose|resolve|finish|end|named clue)\b/i.test(action);
}

function hasObjectiveProofContext(text) {
  const value = String(text || '').toLowerCase();
  const proof = /\b(?:proof|ledger|manifest|coffer|lockbox|packet|slips?|chit|tally|seal|names?|records?|papers?|route|cargo|wagon|cache|manifest)\b/.test(value);
  const setting = /\b(?:guild|merchant|factor|clerk|quay|ford|ferry|cache|weighhouse|warehouse|countinghouse|river|road|shipment|teamster|coffer|seln|harvek|doss)\b/.test(value);
  return proof && setting;
}

function hasBreadcrumbEnding(narration) {
  const ending = String(narration || '').replace(/\s+/g, ' ').trim().slice(-750).toLowerCase();
  return /\b(?:bolts?|flees?|runs?|dives?|escapes?|vanish(?:es|ed)?|retreats?|scatter|scatters|old ferry path|ferry path|cache house|cache lead|ferry cache|old ferry posts|south quay weighhouse|upper tally room|trap ledger|floorboards|duplicate (?:cargo )?(?:tallies|sheets)|destroying duplicate|before dusk|evening bell|dock guards?|coming up the stairs|delay anyone|lead exposed|place,? the timing,? and proof|acting now|violence is about to break|evidence burning|papers? burning|lantern tips?|spilled tar|risk of the evidence|one name circled|quaymaster|harvek doss|sable|sable is below|below the quay|old tide tunnel|hidden stair|lower stair|approaching footsteps|scrapes? hard against stone|trying to spit out a name|before they silence|lead but lose|lose part of the paper trail|new lead|next lead|next answer|another tunnel|another intermediary)\b/.test(ending);
}

function shouldClosePayoffNarration(narration, actionText, assistantHistory) {
  if (!isPayoffSeekingAction(actionText)) return false;
  if ((assistantHistory || []).length < 3) return false;
  const combined = `${(assistantHistory || []).slice(-6).join(' ')} ${narration || ''}`;
  if (!hasObjectiveProofContext(combined)) return false;
  const matureLoop = (assistantHistory || []).length >= 4;
  const breadcrumb = hasBreadcrumbEnding(narration);
  const bossAboveBoss = /\b(?:seln|harvek doss|quaymaster|guild factors?|higher up|upper tally room|trap ledger|south quay weighhouse)\b/i.test(narration || '') &&
    /\b(?:factor|clerk|guild|coffer|manifest|ledger|packet|cache|proof)\b/i.test(combined);
  return matureLoop && (breadcrumb || bossAboveBoss);
}

function extractAccountableName(text) {
  const value = String(text || '');
  const fullName = value.match(/\b(Harvek\s+Doss|House\s+[A-Z][a-z]+)\b/);
  if (fullName) return fullName[1];
  const single = value.match(/\b(Seln|Sable)\b/);
  if (single) return single[1];
  const titled = value.match(/\b(?:Factor|Clerk|Quaymaster|Dockmaster|Broker|Guildmaster)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/);
  if (titled) return titled[1];
  const named = value.match(/\b(?:culprit|responsible|signatory|payer|buyer|traitor|clerk|quaymaster)\s+(?:is|was|named|called)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/);
  if (named) return named[1];
  const twoWordNames = value.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || [];
  return twoWordNames.find(name => !/\b(?:Greyhook Market|Blackreed Ford|Mara Pell|Joren Pell)\b/.test(name)) || 'the exposed culprit';
}

function extractProofObject(text) {
  const value = String(text || '').toLowerCase();
  const proofWords = ['trap ledger', 'duplicate cargo tallies', 'duplicate sheets', 'payoff slips', 'sealed manifests', 'guild lockbox', 'iron-bound coffer', 'dented guild lockbox', 'packet', 'ledger', 'manifest', 'coffer', 'lockbox', 'tally rod', 'travel chit', 'papers'];
  return proofWords.find(word => value.includes(word)) || 'the proof';
}

function buildSplitPayoffClosure({ narration, actionText, assistantHistory }) {
  const combined = `${(assistantHistory || []).slice(-6).join(' ')} ${actionText || ''} ${narration || ''}`;
  const culprit = extractAccountableName(combined);
  const proof = extractProofObject(combined);
  return `The chase stops here. ${culprit} is forced into the open in this scene: ${proof} is secured, the witness confirms the scheme, and the remaining accomplice loses the nerve to keep running. One cost still lands—the papers are scorched, the crowd hears ugly names, or the guild now knows the party has leverage—but the truth no longer moves to another room, quay, stair, or hidden cache. The party has enough to expose ${culprit}, demand passage and supplies, or force restitution from the guild. This beat is resolved; the next decision is what price to make them pay.`;
}

function buildSplitPayoffOptions({ narration, actionText, assistantHistory }) {
  const combined = `${(assistantHistory || []).slice(-6).join(' ')} ${actionText || ''} ${narration || ''}`;
  const culprit = extractAccountableName(combined);
  return [
    `Expose ${culprit} publicly and collect the promised concession`,
    'Demand supplies, passage, and restitution from the guild',
    'Move to the next story beat',
  ];
}

function shouldAdvanceAfterResolvedBeat(actionText, assistantHistory, narration = '') {
  const latest = (assistantHistory || [])[assistantHistory.length - 1] || '';
  if (!hasRecentResolvedBeat(assistantHistory)) return false;
  if (!isClosedBeatAftermathAction(actionText)) return false;
  if (isFreshBeatBoundary(latest)) return false;
  if (/\bThis beat is resolved\b|\btruth no longer moves to another room\b/i.test(latest)) return true;
  return isGenericResolvedObjectiveAction(actionText) || reopensClosedGuildObjective(narration);
}

function buildResolvedBeatAdvance() {
  return 'The guild matter closes instead of reopening. Witnesses take custody of the proof, the promised supplies and passage are granted, and the party leaves with public leverage rather than another errand. By dusk, the next story beat is already waiting beyond Greyhook: a sealed roadside waystation with its bell ringing hard and no visible hand on the rope. The old ledger trail is behind you; this is a new problem.';
}

function shouldKeepFreshBeatAfterClosure(actionText, assistantHistory, narration) {
  const latest = (assistantHistory || [])[assistantHistory.length - 1] || '';
  if (!hasRecentResolvedBeat(assistantHistory) || !isFreshBeatBoundary(latest)) return false;
  return isGenericResolvedObjectiveAction(actionText) || reopensClosedGuildObjective(narration);
}

function buildFreshBeatContinuation(assistantHistory) {
  const latest = (assistantHistory || [])[assistantHistory.length - 1] || '';
  if (/\b(?:riders below|black-wax tube|courier horn|burning sky)\b/i.test(latest)) {
    return {
      narration: 'The old guild lead stays closed. The pursuit pays off in motion: the rider with the black-wax tube is cut off at the switchback, the horn never sounds, and the tube cracks open in the dust. Inside is not another errand but a target: a charcoal map of the north road, three marked safehouses, and tonight\'s meeting point circled at the ruined aqueduct. The party has momentum now; the next choice is whether to ambush the meeting or turn the map into public leverage.',
      options: [
        'Ambush the ruined-aqueduct meeting before dusk',
        'Use the safehouse map to flip an informant',
        'Expose the black-wax route publicly and force a reaction',
      ],
    };
  }

  if (/\b(?:watchtower|signal fire|black-wax line is broken)\b/i.test(latest)) {
    return {
      narration: 'The old guild lead stays closed. The watchtower is no paperwork trail: its signal fire has just been lit, and three riders below are cutting loose before the party can ask gentle questions. One rider carries a matching black-wax tube; another has a courier horn at his belt. This beat is now pursuit under a burning sky, not another ledger.',
      options: [
        'Cut off the rider with the black-wax tube',
        'Shoot the courier horn from the second rider\'s belt',
        'Let one rider flee and follow the signal route',
      ],
    };
  }

  if (/\b(?:vessa coil|masked patron|obsidian bell|hill-shrine crypt|seal-holder)\b/i.test(latest)) {
    return {
      narration: 'The old guild lead stays closed. Vessa Coil breaks when the obsidian bell rings below the hill-shrine floor; she did not buy stolen cargo for profit, but to keep that bell sealed. Her confession gives the party a name, a danger, and a cost: expose her and the wardens lose their funding, or take the black-wax map to the old watchtower before the patron sends riders to erase it. The black-wax line is broken open, and the next beat is already moving.',
      options: [
        'Expose Vessa and accept the wardens\' anger',
        'Take the black-wax map to the old watchtower',
        'Demand Vessa fund the pursuit before she falls',
      ],
    };
  }

  if (/\b(?:cracked altar|black-wax satchel|broken signet|route sketch|hill shrine)\b/i.test(latest)) {
    return {
      narration: 'The old guild lead stays closed. The route sketch pays off at the hill shrine: beneath the split lintel, the broken signet matches the ring of Vessa Coil, a veiled patron waiting beside an open crypt stair. She expected a courier, not witnesses. When the party names the black wax, Vessa\'s hand moves to a bronze pull-chain and a deep obsidian bell answers from below. The confrontation is here; the danger is what that bell just woke.',
      options: [
        'Stop Vessa before she pulls the chain again',
        'Demand the truth about the obsidian bell',
        'Dive into the crypt before the awakened thing rises',
      ],
    };
  }

  if (/\b(?:hooded courier|thorn-choked|roadside chapel|chapel door|courier disappears)\b/i.test(latest)) {
    return {
      narration: 'The old guild lead stays closed. At the thorn-choked roadside chapel, the courier is no longer a rumor ahead of the party: he is at the cracked altar, one hand on a black-wax satchel and the other on a knife he is not brave enough to use. Inside the satchel is a route sketch toward the hill shrine and a broken signet pressed into the wax. The choice is immediate: seize him, bargain for the name behind the seal, or let him run and follow the map.',
      options: [
        'Seize the courier before he burns the satchel',
        'Offer the courier protection for the name behind the black wax',
        'Let the courier run and follow the hill-shrine map',
      ],
    };
  }

  if (/\b(?:black wax|shrine road)\b/i.test(latest)) {
    return {
      narration: 'The old guild lead stays closed. The party follows the messenger\'s clue instead of circling the warehouse story: fresh prints leave the rear hatch and cut toward the shrine road, where black wax is smeared across a cracked milestone. Ahead, a hooded courier drags a satchel into the thorn-choked roadside chapel. The witness paid off; the next beat is pursuit, leverage, or a risky call before the courier disappears.',
      options: [
        'Rush the courier before the chapel door closes',
        'Circle the thorn chapel and cut off the rear exit',
        'Call out the black wax clue and demand a parley',
      ],
    };
  }

  if (/\b(?:south-road|south road|loss site|wrecked milestone|collapsed culvert|clawed tracks|hidden den|scavenger beast|creature|mule bones)\b/i.test(latest)) {
    return {
      narration: 'The guild scandal stays behind the party. At the south-road culvert, the current clue is physical and immediate: clawed tracks, torn canvas, mule bones, and a sour carrion heat breathing from the collapsed stone. Something inside drags a stamped crate deeper into the dark with deliberate strength. The choice is no longer paperwork; it is whether to expose, trap, or speak to whatever has been feeding on the stolen cargo.',
      options: [
        'Light the culvert and identify what is feeding there',
        'Set a rope line and draw the creature into the open',
        'Call into the den and offer food for answers',
      ],
    };
  }

  if (/\b(?:wounded messenger|fresh footprints|rear hatch|pull-chain|drag mark)\b/i.test(latest)) {
    return {
      narration: 'The old guild lead stays closed. At the waystation, the usable clue is the living one: the wounded messenger grips Kael\'s sleeve and forces out a name between panicked breaths, "Black wax... rear hatch... shrine road." Helping him will cost precious minutes; chasing the fresh footprints now risks leaving the only witness bleeding on the floor.',
      options: [
        'Stabilize the messenger and demand one clear name',
        'Follow the fresh footprints toward the shrine road',
        'Split the party between triage and pursuit',
      ],
    };
  }

  return {
    narration: 'The old guild lead stays closed. At the sealed waystation, the party puts the only current clue in front of the room itself: the snapped rope, the drag smear, and the bell mechanism hammered to keep ringing after someone fled. The answer is immediate and ugly: a wounded messenger is trapped under fallen shelving in the service room, alive but fading, while fresh footprints cut toward the rear hatch.',
    options: [
      'Free the wounded messenger and ask who set the bell',
      'Follow the fresh footprints through the rear hatch',
      'Disable the bell mechanism and search the service room',
    ],
  };
}

function closeDeferredPayoffIfNeeded(parsed, actionText, gs) {
  const assistantHistory = getAssistantHistory(gs);
  if (shouldKeepFreshBeatAfterClosure(actionText, assistantHistory, parsed?.narration)) {
    return {
      ...parsed,
      ...buildFreshBeatContinuation(assistantHistory),
      freshBeatGuarded: true,
    };
  }
  if (shouldAdvanceAfterResolvedBeat(actionText, assistantHistory, parsed?.narration)) {
    return {
      ...parsed,
      narration: buildResolvedBeatAdvance(),
      options: [
        'Enter the sealed waystation and look for survivors',
        'Circle the waystation for tracks before opening the door',
        'Call out and demand whoever is ringing the bell answer',
      ],
      resolvedBeatAdvanced: true,
    };
  }
  if (!shouldClosePayoffNarration(parsed?.narration, actionText, assistantHistory)) return parsed;
  return {
    ...parsed,
    narration: buildSplitPayoffClosure({
      narration: parsed.narration,
      actionText,
      assistantHistory,
    }),
    options: buildSplitPayoffOptions({
      narration: parsed.narration,
      actionText,
      assistantHistory,
    }),
    payoffClosed: true,
  };
}

const FEROCITY_LABELS = {
  1: 'Deadly (lethal, every encounter is life-threatening)',
  2: 'Dangerous (tough fights, meaningful consequences)',
  3: 'Balanced (challenging but fair)',
  4: 'Light (manageable encounters, low death risk)',
  5: 'Easy (heroic power fantasy, minimal threat)',
};

const PERSONA_BLOCKS = {
  epic: `You are an EPIC Dungeon Master: dramatic, grounded, atmospheric. Use tight prose, real stakes, and specific consequences.`,

  over_the_top: `You are an OVER THE TOP Dungeon Master: comedic, chaotic, full of Critical Role energy. Give NPCs vivid quirks and consequential choices.`,
};

function formatResolvedCombatState(lastCombatConclusion) {
  if (!lastCombatConclusion) return '';

  const defeated = Array.isArray(lastCombatConclusion.defeated)
    ? lastCombatConclusion.defeated.filter(Boolean)
    : [];
  const reason = lastCombatConclusion.reason || 'resolved';
  const summary = lastCombatConclusion.summary || '';
  const defeatedLine = defeated.length > 0
    ? `Defeated opponents: ${defeated.join(', ')}.`
    : '';

  return [
    `=== RESOLVED COMBAT STATE ===`,
    `Last combat result: ${reason}.`,
    defeatedLine,
    summary ? `Outcome: ${summary}` : '',
    `This outcome is permanent story state: defeated opponents are already defeated. Do not revive them, restart the same fight, or make them attack again unless the current player explicitly causes that reversal.`,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// buildNarrationPrompt
// ---------------------------------------------------------------------------

/**
 * Build ~800 token model system prompt.
 * Includes: persona, characters (no stat blocks), story summary,
 * campaign material, house rules, NPC memory, encounter guidance,
 * ferocity, pillars, verbosity rules.
 */
function buildNarrationPrompt(gameId, gameConfig, gs) {
  const persona = gameConfig.dmPersona || 'epic';
  const personaBlock = PERSONA_BLOCKS[persona] || PERSONA_BLOCKS.epic;

  // Character block — names/personalities only, NO stat blocks
  // Accept either gs.characters (array of { name, data }) or gs.data.characters (dict of { [name]: charData })
  let characters = (gs.characters || []);
  if (characters.length === 0 && gs.data && gs.data.characters && typeof gs.data.characters === 'object') {
    characters = Object.entries(gs.data.characters).map(([name, charData]) => ({ name, data: charData }));
  }
  const charLines = characters.map(ch => {
    const d = ch.data || {};
    const firstSentenceOfBackstory = d.backstory
      ? (d.backstory.split(/[.!?]/)[0] || '').trim()
      : '';
    const catchphrases = Array.isArray(d.catchphrases) && d.catchphrases.length > 0
      ? `Catchphrases: "${d.catchphrases.join('", "')}".`
      : '';
    const standardActions = Array.isArray(d.standardActions)
      ? (d.standardActions.length > 0 ? `Typical actions: ${d.standardActions.join(', ')}.` : '')
      : (typeof d.standardActions === 'string' && d.standardActions
          ? `Typical actions: ${d.standardActions}.`
          : '');
    return [
      `  - ${ch.name} (${d.class || 'Adventurer'} ${d.level || 1})`,
      d.personality ? `    Personality: ${d.personality}` : '',
      firstSentenceOfBackstory ? `    Background: ${firstSentenceOfBackstory}.` : '',
      catchphrases ? `    ${catchphrases}` : '',
      standardActions ? `    ${standardActions}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');

  // NPC memory (up to 5)
  const npcs = gs.world?.npcs ? Object.values(gs.world.npcs) : [];
  const npcLines = npcs.slice(0, 5).map(npc =>
    `  - ${npc.name}: ${npc.personality || 'unknown'}${npc.lastSeen ? ` (last seen: ${npc.lastSeen})` : ''}`
  ).join('\n');

  // Campaign source material (capped at 50000 chars)
  const rawContext = gameConfig.custom_context || '';
  const campaignMaterial = rawContext.length > 50000
    ? rawContext.slice(0, 50000) + '\n[... truncated for length ...]'
    : rawContext;

  // House rules
  const houseRules = gameConfig.house_rules || '';

  // Story summary
  const storySummary = gs.storySummary || '';
  const resolvedCombatState = formatResolvedCombatState(gs.lastCombatConclusion);

  // Encounter plan
  let encounterGuidance = '';
  if (gs.encounterPlan) {
    try {
      encounterGuidance = formatPlanForPrompt(gs.encounterPlan, gs.encounterPlanIndex || 0);
    } catch (err) {
      encounterGuidance = '';
    }
  }
  if (gs._encounterPacingDirective) {
    encounterGuidance += `${encounterGuidance ? '\n' : ''}${gs._encounterPacingDirective}`;
  }

  // Ferocity
  const ferocity = gs.ferocity || 3;
  const ferocityDesc = FEROCITY_LABELS[ferocity] || FEROCITY_LABELS[3];

  // Pillars
  const pillars = gs.pillars || {};
  const pillarsLine = `Combat ${pillars.combat || 33}% / Exploration ${pillars.exploration || 33}% / Social ${pillars.social || 33}%`;

  // Verbosity
  const verbosity = gs.verbosity || 'brief';
  const verbosityRule = VERBOSITY_RULES[verbosity] || VERBOSITY_RULES.brief;

  const sections = [
    `=== DM PERSONA ===`,
    personaBlock,
    '',
    `=== CAMPAIGN ===`,
    `Game: ${gameConfig.name || 'Untitled'}`,
    `System: ${gameConfig.system || 'dnd5e'}`,
    '',
    characters.length > 0 ? `=== PLAYER CHARACTERS ===\n${charLines}` : '',
    '',
    npcs.length > 0 ? `=== NPC MEMORY (recent) ===\n${npcLines}` : '',
    '',
    storySummary ? `=== STORY SO FAR ===\n${storySummary}` : '',
    '',
    resolvedCombatState,
    '',
    campaignMaterial ? `=== CAMPAIGN SOURCE MATERIAL ===\n${campaignMaterial}` : '',
    '',
    houseRules ? `=== HOUSE RULES ===\n${houseRules}` : '',
    '',
    encounterGuidance ? `=== ENCOUNTER GUIDANCE ===\n${encounterGuidance}` : '',
    '',
    `=== DIFFICULTY ===`,
    `Ferocity ${ferocity}: ${ferocityDesc}`,
    `Pillars: ${pillarsLine}`,
    '',
    `=== STORY MOMENTUM ===`,
    `- ${STORY_MOMENTUM_RULES}`,
    '',
    `=== OPTION QUALITY ===`,
    `- ${OPTION_QUALITY_RULES}`,
    '',
    `=== NARRATION RULES ===`,
    `CRITICAL: Your narration MUST directly acknowledge and respond to the player's action. Show what happens as a direct consequence of their choice. Do not ignore or bypass their action — make it clear their decision matters and shapes the world.`,
    `VERBOSITY: ${verbosityRule}`,
    ``,
    `Always end your response with exactly 3 numbered player options using this format:`,
    `1️⃣ [option one]`,
    `2️⃣ [option two]`,
    `3️⃣ [option three]`,
    `Do not use markdown headers (##, ###) in narration. Never roll dice yourself — all dice outcomes are resolved by the server. Never mention HP numbers, AC, or stat blocks. Never break character as DM.`,
  ].filter(s => s !== null && s !== undefined).join('\n');

  return sections;
}

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

/**
 * Build user message with corrections injection + chat history + player action.
 * Consumes (clears) gs.pendingCorrections.
 */
function buildUserMessage(gs, characterName, actionText) {
  const parts = [];

  // Inject corrections if present, then clear them
  const corrections = gs.pendingCorrections || [];
  if (corrections.length > 0) {
    // Corrections may be stored as strings (key/message format) or objects (type/description/correction format)
    const correctionTexts = corrections.map(c =>
      typeof c === 'string' ? c : (c.correction || c.description || JSON.stringify(c))
    );
    parts.push(`[DM CORRECTIONS — apply immediately and silently:\n${correctionTexts.map((c, i) => `${i + 1}. ${c}`).join('\n')}]`);
    gs.pendingCorrections = [];
  }

  // Chat history
  const history = getCurrentChatHistory(gs);
  if (history.length > 0) {
    const historyLines = history.map(msg => {
      const role = msg.role === 'assistant' ? 'DM' : (msg.name || characterName || 'Player');
      return `${role}: ${msg.content}`;
    });
    parts.push(`[RECENT HISTORY]\n${historyLines.join('\n')}`);

    const antiStallDirective = buildAntiStallPacingDirective(history, actionText);
    if (antiStallDirective) {
      parts.push(antiStallDirective);
      parts.push(`[INTERPRETED INTENT]\nThe party proceeds to the current named lead now. If a destination, contact, room, or visible threat has already been named, cut directly to it and show the immediate consequence.`);
    }

    const resolvedBeatAdvanceDirective = buildResolvedBeatAdvanceDirective(history, actionText);
    if (resolvedBeatAdvanceDirective) {
      parts.push(resolvedBeatAdvanceDirective);
      parts.push(`[INTERPRETED INTENT]\nThe party moves on from the resolved beat now.`);
    }

    const freshBeatStaleActionDirective = buildFreshBeatStaleActionDirective(history, actionText);
    if (freshBeatStaleActionDirective) {
      parts.push(freshBeatStaleActionDirective);
      parts.push(`[INTERPRETED INTENT]\nResolve the player's intent against the current scene, not a completed prior objective.`);
    }
  }

  const resolvedCombatState = formatResolvedCombatState(gs.lastCombatConclusion);
  if (resolvedCombatState) {
    parts.push(`[${resolvedCombatState}]`);
  }

  // Player action with system override instruction
  const systemOverride = `CRITICAL: The player has chosen an action below. You MUST narrate ONLY what happens as a direct consequence of that choice. Begin after the latest DM message. Do not reproduce or paraphrase any full sentence from RECENT HISTORY. If the player's action overlaps with a recent beat, compress the overlap and reveal the next new consequence, discovery, NPC reaction, cost, or decision. Do not repeat previous narrations or generic descriptions. Treat RECENT HISTORY as binding continuity: keep the same named lead, contact, or destination until the party reaches, resolves, or clearly loses it. Never describe a non-empty progress action as doing nothing useful, hesitation, or inaction; partial intent advances the current lead.\n\n`;
  parts.push(systemOverride);
  parts.push(`PLAYER ACTION: ${characterName} chooses: ${actionText}`);
  parts.push(`\nRespond directly. Narrate what happens because of this choice ONLY.`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// buildExtractionPrompt
// ---------------------------------------------------------------------------

/**
 * structured model extraction prompt for world state changes.
 */
function buildExtractionPrompt(narration, actionText, worldState) {
  return `You are a world state extractor for a tabletop RPG game. Given the DM narration and player action, extract any changes to the world state.

PLAYER ACTION:
${actionText}

DM NARRATION:
${narration}

CURRENT WORLD STATE:
${JSON.stringify(worldState, null, 2)}

Extract changes as JSON with this structure:
{
  "scene": {"action": "5-10 word summary", "mood": "1-3 words", "npc": "name or null"},
  "locations": [{"name": "...", "description": "...", "distance": "...", "isNew": true, "img": "one sentence visual or null"}],
  "npcs": [{"name": "...", "description": "...", "location": "...", "isNew": true, "img": "one sentence visual or null"}],
  "enemies": [{"displayName": "...", "count": 1, "slug": "monster-db-slug"}],
  "map": "current location name",
  "accomplishments": [{"character": "...", "achievement": "..."}],
  "charUpdates": [{"character": "...", "field": "statsText|personality|backstory|standardActions", "value": "..."}]
}

Rules:
- "isNew" = true ONLY if entity does NOT appear in CURRENT WORLD STATE
- "img" ONLY for isNew entities
- "enemies" ONLY if hostile creatures are actively attacking, forcing initiative, or the player clearly chose violence. Do not extract enemies from merchant/watch/checkpoint/social/travel scenes by proximity alone.
- "slug" must be a plausible monster database key (lowercase, hyphenated). Use "custom" if unsure.
- Omit empty arrays entirely
- Return ONLY the JSON object, no explanation`;
}

// ---------------------------------------------------------------------------
// buildValidationPrompt
// ---------------------------------------------------------------------------

/**
 * structured model validation prompt checking narration against game state.
 */
function buildValidationPrompt(narration, options, gameState) {
  return `You are a rules compliance validator for a tabletop RPG game. Check the DM narration for violations.

DM NARRATION:
${narration}

PLAYER OPTIONS:
${(options || []).map((o, i) => `${i + 1}. ${o}`).join('\n')}

GAME STATE CONTEXT:
System: ${gameState.system || 'dnd5e'}
Ferocity: ${gameState.ferocity || 3}

Check for violations:
1. Did the DM roll dice or mention specific dice outcomes? (critical violation)
2. Did the DM reveal HP numbers, AC values, or stat block info? (minor violation)
3. Did the DM break character or address the players meta-game? (minor violation)
4. Are all 3 player options distinct and meaningful? (minor violation if not)

Return JSON:
{
  "violations": [
    { "severity": "critical|minor", "key": "short_key", "message": "description" }
  ]
}

Return ONLY the JSON object. If no violations, return { "violations": [] }`;
}

// ---------------------------------------------------------------------------
// parseNarrationResponse
// ---------------------------------------------------------------------------

function getStructuredMarkerPositions(text) {
  const markerRegex = createStructuredMarkerRegex('gim');
  const positions = [];

  for (const match of text.matchAll(markerRegex)) {
    let name = (match[1] || match[2] || '').toLowerCase();
    if (name === 'option') name = 'options';
    positions.push({ name, idx: match.index, len: match[0].length });
  }

  return positions.sort((a, b) => a.idx - b.idx);
}

function parseOptionLine(line) {
  const emojiOptionRe = /^([1-3])️⃣\s*/u;
  const numberedOptionRe = /^([1-3])[.)]\s+/;

  if (emojiOptionRe.test(line)) {
    return line.replace(emojiOptionRe, '').trim();
  }
  if (numberedOptionRe.test(line)) {
    return line.replace(numberedOptionRe, '').trim();
  }
  return null;
}

function extractOptions(text) {
  return text
    .split('\n')
    .map(line => parseOptionLine(line.trim()))
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * Extract narration + options from model's response.
 * Lines matching ^[1-3]️⃣ are options (emoji format).
 * Lines matching ^[1-3][.)] are options (numbered format).
 * Structured ---OPTIONS---/---SCENE---/---WORLD--- blocks are stripped from narration.
 * If fewer than 2 option-like lines found outside structured blocks, treat entire text as narration with empty options.
 * Returns { narration, options } where options is array of up to 3 strings.
 */
function parseNarrationResponse(text) {
  if (!text || text.trim() === '') {
    return { narration: '', options: [] };
  }

  const markerPositions = getStructuredMarkerPositions(text);
  if (markerPositions.length > 0) {
    const narration = text.slice(0, markerPositions[0].idx).trim();
    let optionsRaw = '';

    for (let i = 0; i < markerPositions.length; i++) {
      const start = markerPositions[i].idx + markerPositions[i].len;
      const end = i + 1 < markerPositions.length ? markerPositions[i + 1].idx : text.length;
      if (markerPositions[i].name === 'options') {
        optionsRaw += '\n' + text.slice(start, end).trim();
      }
    }

    return {
      narration,
      options: extractOptions(optionsRaw),
    };
  }

  const lines = text.split('\n');
  const narrationLines = [];
  const optionLines = [];

  for (const line of lines) {
    const optionText = parseOptionLine(line.trim());
    if (optionText) {
      optionLines.push(optionText);
    } else {
      narrationLines.push(line);
    }
  }

  // If fewer than 2 option-like lines, treat everything as narration
  if (optionLines.length < 2) {
    return { narration: text.trim(), options: [] };
  }

  return {
    narration: narrationLines.join('\n').trim(),
    options: optionLines.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// processViolation
// ---------------------------------------------------------------------------

/**
 * Route critical violations immediately, escalate minor after 3 consecutive.
 */
function processViolation(gs, violation) {
  if (!gs.pendingCorrections) gs.pendingCorrections = [];
  if (!gs.minorViolationCounts) gs.minorViolationCounts = {};

  const { severity } = violation;
  // Support both { key, message } (structured model validation format) and { type, description, correction } (pipeline format)
  const key = violation.key || violation.type;
  // Store the full violation object when using the type/description format, else store message string
  const payload = violation.description !== undefined ? violation : violation.message;

  if (severity === 'critical') {
    gs.pendingCorrections.push(payload);
    return;
  }

  // Minor violation
  const current = gs.minorViolationCounts[key] || 0;
  const next = current + 1;

  if (next >= 3) {
    gs.pendingCorrections.push(payload);
    gs.minorViolationCounts[key] = 0;
  } else {
    gs.minorViolationCounts[key] = next;
  }
}

// ---------------------------------------------------------------------------
// shouldCallModelForFlavor
// ---------------------------------------------------------------------------

/**
 * Returns true on round 1, every 3rd round, or when combat is over.
 */
function shouldCallModelForFlavor(combatState) {
  if (!combatState) return true;
  if (!combatState.active || combatState.over) return true;
  const round = combatState.round || 1;
  if (round === 1) return true;
  if (round % 3 === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// API call: model narration (streamed)
// ---------------------------------------------------------------------------

/**
 * Streamed model API call for narration.
 * Emits: dm_stream_start, dm_stream_chunk, dm_stream_end via io.
 */
async function callModelNarration(gameId, gameConfig, gs, characterName, actionText, io, storyFlags) {
  const { buildFullPrompt, buildMinimalPrompt } = require('./prompt-builder');
  const encounterDesigner = require('./encounter-designer');

  // Select prompt based on story flags and pending challenges
  // Use full prompt for story moments (NPC interactions, exploration, encounter plans)
  const isStoryMoment = storyFlags?.story || gs._pendingChallenge;
  const systemPrompt = isStoryMoment
    ? buildFullPrompt(gameId, gameConfig, () => gs, encounterDesigner)
    : buildMinimalPrompt(gameConfig, gs);
  const userMessage = buildUserMessage(gs, characterName, actionText);

  let fullText = '';
  let visibleNarration = '';
  let pendingNarrationTail = '';
  let streamingState = 'NARRATING';
  const markerRegex = createStructuredMarkerRegex('im');
  let streamEnded = false;

  const emitVisibleChunk = (text) => {
    if (!text) return;
    visibleNarration += text;
    if (io) {
      io.to(gameId).emit('dm_stream_chunk', { gameId, text, chunk: text });
    }
  };

  const bufferStreamChunk = (chunk) => {
    if (!chunk || streamingState !== 'NARRATING') return;

    pendingNarrationTail += chunk;
    const markerMatch = pendingNarrationTail.match(markerRegex);

    if (markerMatch) {
      emitVisibleChunk(pendingNarrationTail.slice(0, markerMatch.index).replace(/\s+$/, ''));
      pendingNarrationTail = '';
      streamingState = 'BUFFERING_STRUCTURED';
      return;
    }

    if (pendingNarrationTail.length > STREAM_MARKER_LOOKAHEAD) {
      emitVisibleChunk(pendingNarrationTail.slice(0, -STREAM_MARKER_LOOKAHEAD));
      pendingNarrationTail = pendingNarrationTail.slice(-STREAM_MARKER_LOOKAHEAD);
    }
  };

  const flushVisibleNarration = () => {
    if (streamingState === 'NARRATING' && pendingNarrationTail) {
      emitVisibleChunk(pendingNarrationTail);
    }
    pendingNarrationTail = '';
  };

  const closeStream = (narration, llmRunId = null) => {
    if (!io || streamEnded) return;
    io.to(gameId).emit('dm_stream_end', {
      gameId,
      narration: narration || 'The world holds its breath...',
      llmRunId,
    });
    streamEnded = true;
  };

  // Emit stream start to the game room
  if (io) {
    io.to(gameId).emit('dm_stream_start', { gameId });
  }

  const verbosityMaxTokens = { terse: 250, brief: 400, verbose: 1500 };
  const maxTokens = verbosityMaxTokens[gs.verbosity] || verbosityMaxTokens.brief;

  try {
    const response = await llm.streamText({
      task: 'narration',
      gameId,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens,
      onToken: (chunk) => {
        fullText += chunk;
        bufferStreamChunk(chunk);
      },
    });
    flushVisibleNarration();

    const responseText = fullText || response.text || '';
    if (!responseText.trim()) {
      const fallback = buildFallbackTurn(characterName, actionText);
      closeStream(fallback.narration, response.llmRunId || null);
      return {
        ...fallback,
        llmRunId: response.llmRunId || null,
        fallback: true,
      };
    }

    const parsed = parseNarrationResponse(responseText);
    parsed.narration = cleanInvalidCombatNarration(parsed.narration);
    if (isLowInformationNarration(parsed.narration, actionText)) {
      const fallback = buildFallbackTurn(characterName, actionText);
      closeStream(fallback.narration, response.llmRunId || null);
      return {
        ...fallback,
        llmRunId: response.llmRunId || null,
        fallback: true,
      };
    }
    const finalized = closeDeferredPayoffIfNeeded(parsed, actionText, gs);
    if (!finalized.options.length && !finalized.payoffClosed) {
      finalized.options = [...FALLBACK_OPTIONS];
    }
    finalized.llmRunId = response.llmRunId;
    closeStream(finalized.narration || responseText.trim(), response.llmRunId);
    return finalized;
  } catch (err) {
    const fallback = buildFallbackTurn(characterName, actionText);
    flushVisibleNarration();
    closeStream(visibleNarration.trim() || fallback.narration, err.llmRunId || null);
    return {
      ...fallback,
      llmRunId: err.llmRunId || null,
      fallback: true,
    };
  }
}

// ---------------------------------------------------------------------------
// API call: structured model extraction (non-streaming)
// ---------------------------------------------------------------------------

/**
 * structured model extraction API call. Returns parsed world state changes.
 */
async function callWorldExtraction(gameId, narration, actionText, worldState) {
  const prompt = buildExtractionPrompt(narration, actionText, worldState);

  try {
    const response = await llm.completeJson({
      task: 'world-extraction',
      gameId,
      prompt,
      schema: worldExtractionSchema,
      maxTokens: 700,
      temperature: 0,
    });
    return response.object;
  } catch (err) {
    console.error(`[narration-pipeline] world extraction failed for game ${gameId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// API call: structured model validation (non-streaming)
// ---------------------------------------------------------------------------

/**
 * structured model validation API call. Returns { violations: [] } on failure.
 */
async function callNarrationValidation(gameId, narration, options, gameState) {
  const prompt = buildValidationPrompt(narration, options, gameState);

  const defaultResult = { violations: [] };

  try {
    const response = await llm.completeJson({
      task: 'validation',
      gameId,
      prompt,
      schema: validationSchema,
      maxTokens: 300,
      temperature: 0,
    });
    return response.object?.violations ? response.object : defaultResult;
  } catch (err) {
    console.error(`[narration-pipeline] validation failed for game ${gameId}:`, err.message);
    return defaultResult;
  }
}

// ---------------------------------------------------------------------------
// handlePlayerAction — main orchestrator
// ---------------------------------------------------------------------------

/**
 * Main orchestrator. Routes combat vs non-combat.
 *
 * deps: { initiateCombat, parseAction, resolveEnemyTurns, persistCombatState, emitCombatUpdate }
 * storyFlags: { story, npc, exploration } — hints for full vs minimal prompt selection
 */
async function handlePlayerAction(gameId, gameConfig, gs, characterName, actionText, io, deps, storyFlags) {
  const {
    initiateCombat,
    parseAction,
    resolveEnemyTurns,
    persistCombatState,
    emitCombatUpdate,
  } = deps || {};

  // Store flags on game state for prompt selection
  gs._turnFlags = storyFlags || {};

  const combatActive = gs.combatEngine?.state?.active;

  // -------------------------------------------------------------------------
  // COMBAT PATH
  // -------------------------------------------------------------------------
  if (combatActive) {
    const combatEngine = gs.combatEngine;

    // Parse and resolve player action
    let parsedAction = null;
    if (parseAction) {
      try {
        parsedAction = await parseAction(actionText, combatEngine.state.combatants, gs.system || gameConfig.system);
      } catch (err) {
        console.error(`[narration-pipeline] parseAction failed:`, err.message);
      }
    }

    // Resolve player action through combat engine
    let playerResults = [];
    if (parsedAction && combatEngine.resolveAction) {
      try {
        playerResults = await combatEngine.resolveAction(parsedAction, characterName);
      } catch (err) {
        console.error(`[narration-pipeline] resolveAction failed:`, err.message);
      }
    }

    // Auto-resolve death saves for downed PCs
    const downedPCs = Object.values(combatEngine.state.combatants || {}).filter(
      c => c.type === 'PC' && c.hp <= 0 && !c.dead
    );
    for (const pc of downedPCs) {
      if (combatEngine.resolveDeathSave) {
        try {
          const dsResult = combatEngine.resolveDeathSave(pc.id);
          if (dsResult) playerResults.push(dsResult);
        } catch (err) {
          // non-fatal
        }
      }
    }

    // Resolve enemy turns
    let enemyResults = [];
    if (resolveEnemyTurns) {
      try {
        enemyResults = await resolveEnemyTurns(gameId, gameConfig);
      } catch (err) {
        console.error(`[narration-pipeline] resolveEnemyTurns failed:`, err.message);
      }
    }

    const allResults = [...playerResults, ...enemyResults];

    // Assemble template narration
    const persona = gameConfig.dmPersona || 'epic';
    let narration = '';
    try {
      narration = await templateEngine.assembleCombatNarration(allResults, combatEngine, persona);
    } catch (err) {
      console.error(`[narration-pipeline] assembleCombatNarration failed:`, err.message);
      narration = 'The battle continues...';
    }

    // Generate tactical options
    let options = [];
    try {
      options = templateEngine.generateCombatOptions(combatEngine, characterName);
    } catch (err) {
      options = ['Attack', 'Dodge', 'Use ability'];
    }

    // Skip model flavor calls during combat - template narration is sufficient
    // Avoid concurrent Socket.IO emissions that could cause text interleaving

    // Check if combat is over
    let combatOver = false;
    if (combatEngine.isCombatOver) {
      const overResult = combatEngine.isCombatOver();
      combatOver = typeof overResult === 'object' ? overResult.over : Boolean(overResult);
    }

    if (combatOver && combatEngine.endCombat) {
      try {
        combatEngine.endCombat();
        const defeated = Object.values(combatEngine.state.combatants || {})
          .filter(c => c.type !== 'PC' && ((c.hp ?? c.totalHp ?? 0) <= 0))
          .map(c => c.name)
          .filter(Boolean);
        gs.lastCombatConclusion = {
          reason: 'combat_over',
          defeated,
          summary: defeated.length > 0
            ? `${defeated.join(', ')} defeated. The fight is over.`
            : 'The fight is over.',
          updatedAt: new Date().toISOString(),
        };
      } catch (err) {
        console.error(`[narration-pipeline] endCombat failed:`, err.message);
      }
    }

    // Persist combat state
    if (persistCombatState) {
      try { persistCombatState(gameId); } catch (err) {
        console.error(`[narration-pipeline] persistCombatState failed:`, err.message);
      }
    }

    // Emit combat update
    if (emitCombatUpdate) {
      try {
        emitCombatUpdate(gameId, combatEngine, io);
      } catch (err) {
        console.error(`[narration-pipeline] emitCombatUpdate failed:`, err.message);
      }
    }

    return {
      narration,
      options,
      scene: null,
      world: null,
      isKillshot: false,
      combatOver,
    };
  }

  // -------------------------------------------------------------------------
  // NON-COMBAT PATH
  // -------------------------------------------------------------------------

  // Call 1: model narration (streamed)
  let narration = '';
  let options = [];
  let llmRunId = null;
  try {
    const narrationResult = await callModelNarration(gameId, gameConfig, gs, characterName, actionText, io, gs._turnFlags);
    narration = narrationResult.narration;
    options = narrationResult.options;
    llmRunId = narrationResult.llmRunId || null;
    if (narrationResult.fallback) {
      return {
        narration,
        options,
        scene: null,
        world: null,
        isKillshot: false,
        llmRunId,
        fallback: true,
      };
    }
  } catch (err) {
    console.error(`[narration-pipeline] callModelNarration failed:`, err.message);
    const fallback = buildFallbackTurn(characterName, actionText);
    narration = fallback.narration;
    options = fallback.options;
    return {
      narration,
      options,
      scene: null,
      world: null,
      isKillshot: false,
      llmRunId,
      fallback: true,
    };
  }

  // Calls 2 & 3: structured model extraction + validation in parallel
  const worldState = gs.world || {};
  const gameStateForValidation = { system: gameConfig.system, ferocity: gs.ferocity };

  const [extractionResult, validationResult] = await Promise.all([
    callWorldExtraction(gameId, narration, actionText, worldState).then(r => r || {}).catch(err => {
      console.error(`[narration-pipeline] callWorldExtraction failed:`, err.message);
      return {};
    }),
    callNarrationValidation(gameId, narration, options, gameStateForValidation).catch(err => {
      console.error(`[narration-pipeline] callNarrationValidation failed:`, err.message);
      return { violations: [] };
    }),
  ]);

  // Check for enemies detected → initiate combat
  const enemies = extractionResult.enemies || [];
  const nonHostileIntent = isDialogueAction(actionText) || isAdvanceAction(actionText);
  const explicitHostileAction = isExplicitHostileAction(actionText);
  if (enemies.length > 0 && initiateCombat && (explicitHostileAction || (!nonHostileIntent && hasHardCombatSignal(narration)))) {
    try {
      await initiateCombat(gameId, gameConfig, enemies);
    } catch (err) {
      console.error(`[narration-pipeline] initiateCombat failed:`, err.message);
    }
  } else if (enemies.length > 0) {
    extractionResult.enemies = [];
    const reason = nonHostileIntent ? 'non-hostile/progress input' : 'no hostile trigger';
    console.log(`[narration-pipeline] suppressed enemies after ${reason}`);
  }

  // Process violations
  const violations = validationResult.violations || [];
  for (const violation of violations) {
    processViolation(gs, violation);
  }

  return {
    narration,
    options,
    scene: extractionResult.scene || null,
    world: extractionResult,
    isKillshot: extractionResult.scene?.action?.toLowerCase().includes('killshot') || false,
    llmRunId,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildNarrationPrompt,
  buildUserMessage,
  formatResolvedCombatState,
  buildExtractionPrompt,
  buildValidationPrompt,
  parseNarrationResponse,
  processViolation,
  shouldCallModelForFlavor,
  callModelNarration,
  callWorldExtraction,
  callNarrationValidation,
  handlePlayerAction,
  buildFallbackTurn,
  isLowInformationNarration,
  buildAntiStallPacingDirective,
  closeDeferredPayoffIfNeeded,
  shouldClosePayoffNarration,
};
