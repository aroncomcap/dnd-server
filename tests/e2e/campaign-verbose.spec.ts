import { test, expect } from '@playwright/test';
import { loginTestUserInBrowser } from './test-user';
import {
  getActionResponseDiagnostics,
  getCompletedDmMessageCount,
  getLastCompletedDmText,
  isActionResponsePending,
  waitForActionResponse,
  waitForPendingActionToSettle,
} from './game-action';

const CAMPAIGN_TIMEOUT_MS = Number(process.env.CAMPAIGN_TIMEOUT_MS || 20 * 60 * 1000);
const TARGET_LEVEL = Number(process.env.CAMPAIGN_TARGET_LEVEL || 3);
const TURNS_PER_LEVEL = Number(process.env.CAMPAIGN_TURNS_PER_LEVEL || 30);
const MAX_SESSIONS = Number(process.env.CAMPAIGN_MAX_SESSIONS || 4);
const MAX_MISSING_RESPONSES = Number(process.env.CAMPAIGN_MAX_MISSING_RESPONSES || 2);
const TURN_READY_TIMEOUT_MS = Number(process.env.CAMPAIGN_TURN_READY_TIMEOUT_MS || process.env.CAMPAIGN_RESPONSE_TIMEOUT_MS || 90000);
const REUSE_CAMPAIGN = process.env.CAMPAIGN_REUSE_CAMPAIGN !== 'false';
const REUSE_ROTATE_HOURS = Number(process.env.CAMPAIGN_REUSE_ROTATE_HOURS || 24);
const REUSE_NAME_PREFIX = process.env.CAMPAIGN_REUSE_NAME_PREFIX || 'Verbose-Reusable-DND5E';
const REUSE_LOOKUP_TIMEOUT_MS = Number(process.env.CAMPAIGN_REUSE_LOOKUP_TIMEOUT_MS || 30000);

test.setTimeout(CAMPAIGN_TIMEOUT_MS);

/**
 * Campaign Verbose Test - Detailed Output
 * Captures and displays: narration, dice rolls, combat, all game events
 */

function getReuseCampaignName() {
  if (!REUSE_CAMPAIGN) return null;
  const rotateMs = Math.max(1, REUSE_ROTATE_HOURS) * 60 * 60 * 1000;
  const bucket = process.env.CAMPAIGN_REUSE_BUCKET || String(Math.floor(Date.now() / rotateMs));
  return `${REUSE_NAME_PREFIX}-${bucket}`;
}

async function findReusableGameId(page, baseURL, gameName) {
  if (!gameName) return null;
  try {
    const gamesRes = await page.request.get(`${baseURL}/api/games`, { timeout: REUSE_LOOKUP_TIMEOUT_MS });
    if (!gamesRes.ok()) return null;
    const games = await gamesRes.json();
    const match = games
      .filter(game => game?.name === gameName)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    return match?.id || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`⚠️  Reusable game lookup skipped: ${message}`);
    return null;
  }
}

async function openNewGameForm(page, baseURL) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(`${baseURL}/new-game`, { waitUntil: 'domcontentloaded' });
    await page.locator('#game-name').waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    const gameNameInput = page.locator('#game-name');
    const createButton = page.locator('#btn-create');
    if (
      await gameNameInput.isVisible().catch(() => false) &&
      await createButton.isVisible().catch(() => false)
    ) {
      return gameNameInput;
    }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  }
  throw new Error(`New game form did not become visible at ${page.url()}`);
}

async function isCombatUiActive(page) {
  return page.evaluate(() => {
    const targetRow = document.querySelector('#target-control-row') as HTMLElement | null;
    const visible = (el: HTMLElement | null) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const state = window as unknown as { __ttsCombatActive?: boolean };
    return Boolean(state.__ttsCombatActive) || visible(targetRow);
  }).catch(() => false);
}

async function hasKnownTurnOwner(page) {
  return page.evaluate(() => {
    const turnName = document.querySelector('#turn-name')?.textContent?.trim() || '';
    return Boolean(turnName && turnName !== '?' && turnName !== '—');
  }).catch(() => false);
}

async function waitForKnownTurnOwner(page) {
  return page.waitForFunction(
    () => {
      const turnName = document.querySelector('#turn-name')?.textContent?.trim() || '';
      return Boolean(turnName && turnName !== '?' && turnName !== '—');
    },
    { timeout: TURN_READY_TIMEOUT_MS }
  ).then(() => true).catch(() => false);
}

async function isLoadingOverlayActive(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('loading-overlay') as HTMLElement | null;
    if (!overlay) return false;
    const style = window.getComputedStyle(overlay);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }).catch(() => false);
}

async function waitForLoadingOverlayToClear(page, timeout = 5000) {
  return page.waitForFunction(
    () => {
      const overlay = document.getElementById('loading-overlay') as HTMLElement | null;
      if (!overlay) return true;
      const style = window.getComputedStyle(overlay);
      return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    },
    { timeout }
  ).then(() => true).catch(() => false);
}

async function clickStartIfAvailable(page) {
  const startBtn = page.locator('#btn-start, button:has-text("START"), button:has-text("Begin")').first();
  const isVisible = await startBtn.isVisible({ timeout: 1000 }).catch(() => false);
  const isEnabled = await startBtn.isEnabled().catch(() => false);
  if (!isVisible || !isEnabled) return false;
  await startBtn.click();
  await page.waitForTimeout(1000);
  return true;
}

async function openHostScreen(page) {
  await waitForLoadingOverlayToClear(page);
  if (await isLoadingOverlayActive(page)) return false;
  const hostButton = page.locator('nav button[data-screen="host"], button:has-text("HOST")').first();
  if (await hostButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await hostButton.click({ timeout: 5000 });
    await page.waitForTimeout(250);
    return true;
  }
  return false;
}

async function ensureGameStarted(page) {
  const clickedInitialStart = await clickStartIfAvailable(page);
  if (clickedInitialStart && await waitForKnownTurnOwner(page)) return true;
  if (await hasKnownTurnOwner(page)) return true;
  if (await isLoadingOverlayActive(page) && await waitForKnownTurnOwner(page)) return true;
  if ((await getCompletedDmMessageCount(page)) > 0) {
    return waitForKnownTurnOwner(page);
  }

  if (await openHostScreen(page)) {
    const promptInput = page.locator('#host-prompt');
    if (await promptInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      const promptText = await promptInput.inputValue().catch(() => '');
      if (!promptText.trim()) {
        await promptInput.fill('A new chapter in your adventure begins.');
      }
    }
    if (await clickStartIfAvailable(page)) {
      const gameButton = page.locator('nav button[data-screen="game"], button:has-text("GAME")').first();
      if (await gameButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await gameButton.click();
      }
      return waitForKnownTurnOwner(page);
    }
  }

  return false;
}

async function pickFallbackAction(page) {
  if (await isCombatUiActive(page)) {
    const actions = ['Attack nearest enemy', 'Dodge', 'Disengage'];
    return actions[Math.floor(Math.random() * actions.length)];
  }
  const recentText = ((await page.locator('body').textContent({ timeout: 500 }).catch(() => '')) || '')
    .replace(/\s+/g, ' ')
    .slice(-2500)
    .toLowerCase();
  if (/\b(?:trap|seam|dart|collapse|unstable|hazard|grating|crawlspace)\b/.test(recentText)) {
    return 'Carefully inspect and bypass the hazard without forcing it';
  }
  if (/\b(?:acolyte|priest|ape|weapons do not lower|violence hesitates)\b/.test(recentText)) {
    return 'Keep weapons lowered and ask what they want';
  }
  if (/\b(?:road|route|lead|map|marker|ruin|gate|trail|path|objective)\b/.test(recentText)) {
    return 'Follow the lead toward the next clear objective';
  }
  if (/\b(?:guild|factor|clerk|toll|steward|passage|merchant)\b/.test(recentText)) {
    return 'State our purpose clearly, ask for the useful lead, and move on';
  }
  const actions = [
    'Ask what the clerk needs from us',
    'Explain that we seek safe passage',
    'Offer peaceful cooperation',
    'Search the scene for useful details',
    'Move on toward the next clear objective',
  ];
  return actions[Math.floor(Math.random() * actions.length)];
}

function isHostileActionText(text: string) {
  return /\b(?:attack|strike|stab|slash|shoot|blast|kill|wound|damage|fire bolt|sacred flame|inflict wounds|magic missile|burning hands|guiding bolt|toll the dead)\b/i.test(text || '');
}

function scoreActionText(text: string, inCombat: boolean) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return -100;
  if (/\bnone\b/i.test(value)) return -100;
  if (inCombat) {
    if (/\b(?:attack|strike|stab|slash|shoot|fire bolt|sacred flame|guiding bolt|magic missile)\b/i.test(value)) return 90;
    if (/\b(?:dodge|disengage|dash)\b/i.test(value)) return 55;
    if (/\b(?:heal|healing|cure|stabilize)\b/i.test(value)) return 50;
    if (/\b(?:help|aid)\b/i.test(value)) return 5;
    return 30;
  }
  if (isHostileActionText(value)) return -90;
  if (/\b(?:move on|press on|continue|proceed|advance|head|travel|enter|follow|route|objective)\b/i.test(value)) return 95;
  if (/\b(?:ask|talk|speak|negotiate|parley|offer|explain|persuade|convince|cooperate)\b/i.test(value)) return 90;
  if (/\b(?:search|inspect|investigate|look|listen|study|examine|scout)\b/i.test(value)) return 75;
  if (/\b(?:heal|healing|cure|bless|guidance)\b/i.test(value)) return 25;
  if (/\b(?:dodge|disengage|dash|ready weapon)\b/i.test(value)) return -40;
  return 45;
}

async function choosePlayableOptionButton(page, buttons) {
  const inCombat = await isCombatUiActive(page);
  const scored = [];
  for (const btn of buttons) {
    const text = (await btn.textContent().catch(() => '')) || '';
    scored.push({ btn, text, score: scoreActionText(text, inCombat) });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < (inCombat ? 10 : 40)) return null;
  return best.btn;
}

test('Campaign Verbose: Level 1-3 with Full Output', async ({ page, baseURL }) => {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║                   TAVERN TABLE - VERBOSE MODE                  ║`);
  console.log(`║         Full Narration, Dice Rolls, and Combat Details          ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

  let totalTurns = 0;
  let gameCount = 0;
  let currentLevel = 1;
  const targetLevel = TARGET_LEVEL;
  const turnsPerLevel = TURNS_PER_LEVEL;
  const deadline = Date.now() + CAMPAIGN_TIMEOUT_MS - 60000;

  while (currentLevel < targetLevel) {
    if (Date.now() > deadline) {
      throw new Error(`Campaign deadline reached before target level. sessions=${gameCount}, turns=${totalTurns}, level=${currentLevel}/${targetLevel}`);
    }
    if (gameCount >= MAX_SESSIONS) {
      throw new Error(`Campaign did not reach target before max sessions. sessions=${gameCount}, turns=${totalTurns}, level=${currentLevel}/${targetLevel}`);
    }

    gameCount++;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`SESSION ${gameCount} - LEVEL ${currentLevel}`);
    console.log(`${'='.repeat(70)}\n`);

    // Authenticate
    const authenticated = await loginTestUserInBrowser(page, baseURL!);
    expect(authenticated).toBe(true);

    let gameId = null;
    const reusableName = getReuseCampaignName();
    if (reusableName) {
      gameId = await findReusableGameId(page, baseURL!, reusableName);
      if (gameId) {
        console.log(`♻️  Reusing game: ${gameId.substring(0, 8)}... (${reusableName})\n`);
        await page.goto(`${baseURL}/game/${gameId}`, { waitUntil: 'domcontentloaded' });
      }
    }

    if (!gameId) {
      const gameName = reusableName || `Verbose-Session${gameCount}-L${currentLevel}`;
      const gameNameInput = await openNewGameForm(page, baseURL!);

      await gameNameInput.fill(gameName);
      await page.locator('#game-system').selectOption('dnd5e');
      await page.locator('#scene-prompt').fill('A new chapter in your adventure begins.');
      await page.locator('#party-direction').fill('Use the existing reusable verbose test party when available; otherwise create four balanced level 1 D&D 5e adventurers.');
      await page.locator('#btn-create').click();

      try {
        await page.waitForURL(/\/game\//, { timeout: 15000 });
      } catch {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      }

      const gameUrl = page.url();
      gameId = gameUrl.match(/\/game\/([a-f0-9-]+)/)?.[1];

      if (!gameId) {
        const gamesRes = await page.request.get(`${baseURL}/api/games`);
        if (gamesRes.ok()) {
          const games = await gamesRes.json();
          if (games.length > 0) {
            gameId = games[0].id;
            await page.goto(`${baseURL}/game/${gameId}`, { waitUntil: 'domcontentloaded' });
          }
        }
      }
    }

    if (!gameId) {
      console.log(`❌ Failed to create game`);
      continue;
    }

    console.log(`✅ Game: ${gameId.substring(0, 8)}...\n`);

    // Start game
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    await ensureGameStarted(page);

    // Play session with verbose capture
    let sessionTurns = 0;
    let noActionCount = 0;
    let missingResponseCount = 0;
    const turnsNeeded = Math.max(1, ((targetLevel - currentLevel) * turnsPerLevel) - (totalTurns % turnsPerLevel));
    const maxSessionTurns = Math.min(50, turnsNeeded);
    const maxNoAction = 6;

    console.log(`🎮 PLAYING SESSION...\n`);

    while (sessionTurns < maxSessionTurns && noActionCount < maxNoAction) {
      // Wait for loading
      if (Date.now() > deadline) {
        throw new Error(`Campaign deadline reached during session. session=${gameCount}, sessionTurns=${sessionTurns}, totalTurns=${totalTurns}, level=${currentLevel}/${targetLevel}`);
      }

      try {
        await page.waitForFunction(
          () => {
            const overlay = document.getElementById('loading-overlay');
            if (!overlay) return true;
            const style = window.getComputedStyle(overlay);
            return style.display === 'none' || style.visibility === 'hidden';
          },
          { timeout: 3000 }
        );
      } catch {
        // Continue anyway
      }

      await page.waitForTimeout(200);
      if (!await hasKnownTurnOwner(page)) {
        const turnReady = await waitForKnownTurnOwner(page);
        if (!turnReady) noActionCount++;
        continue;
      }

      // Try to take action
      let actionTaken = false;
      let responseAlreadyReady = false;
      const beforeDmCount = await getCompletedDmMessageCount(page);

      const optionButtons = await page.locator('button[class*="option"], button:has-text("→")').all();
      const readyOptionButtons = [];
      for (const btn of optionButtons) {
        const isReady = await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false);
        if (isReady) readyOptionButtons.push(btn);
      }
      if (readyOptionButtons.length > 0) {
        const randomBtn = await choosePlayableOptionButton(page, readyOptionButtons);
        try {
          if (randomBtn) {
            await randomBtn.click({ timeout: 2000 });
            actionTaken = true;
            noActionCount = 0;
          }
        } catch {
          try {
            if (randomBtn) {
              await randomBtn.click();
              actionTaken = true;
              noActionCount = 0;
            }
          } catch {
            // Failed
          }
        }
      }

      // Try textarea input
      if (!actionTaken) {
        const inputs = await page.locator('textarea, input[placeholder*="action" i]').all();
        for (const input of inputs) {
          const isVisible = await input.isVisible().catch(() => false);
          if (isVisible) {
            const action = await pickFallbackAction(page);
            try {
              await input.fill(action);
              const sendBtn = page.locator('#btn-send');
              const isSendVisible = await sendBtn.isVisible({ timeout: 500 }).catch(() => false);
              const isSendEnabled = await sendBtn.isEnabled().catch(() => false);
              if (isSendVisible && isSendEnabled) {
                await sendBtn.click();
                actionTaken = true;
                noActionCount = 0;
              }
            } catch {
              // Failed
            }
            break;
          }
        }
      }

      if (!actionTaken && await isActionResponsePending(page)) {
        const pendingResult = await waitForPendingActionToSettle(page, beforeDmCount);
        if (pendingResult === 'timeout') {
          missingResponseCount++;
          const diagnostics = await getActionResponseDiagnostics(page, beforeDmCount);
          console.log(`⚠️  Pending action did not produce a completed DM response (${missingResponseCount}/${MAX_MISSING_RESPONSES})`);
          console.log(diagnostics);
          if (missingResponseCount >= MAX_MISSING_RESPONSES) {
            throw new Error(`Campaign stalled waiting for pending action response.\n${diagnostics}`);
          }
          noActionCount++;
          continue;
        }

        if (pendingResult === 'settled') {
          continue;
        }

        actionTaken = true;
        responseAlreadyReady = true;
      }

      if (!actionTaken) {
        noActionCount++;
      } else {
        const responseReady = responseAlreadyReady || await waitForActionResponse(page, beforeDmCount);
        if (!responseReady) {
          missingResponseCount++;
          const diagnostics = await getActionResponseDiagnostics(page, beforeDmCount);
          console.log(`⚠️  No completed DM response after action (${missingResponseCount}/${MAX_MISSING_RESPONSES})`);
          console.log(diagnostics);
          if (missingResponseCount >= MAX_MISSING_RESPONSES) {
            throw new Error(`Campaign stalled waiting for completed DM response.\n${diagnostics}`);
          }
          noActionCount++;
          continue;
        }
        missingResponseCount = 0;

        sessionTurns++;
        totalTurns++;

        // Print verbose output
        const lastBody = await getLastCompletedDmText(page);
        if (lastBody) {
          console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`TURN ${sessionTurns}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`\n${lastBody}\n`);

          // Extract and highlight rolls and combat
          const rollMatches = lastBody.match(/(\d+d\d+(?:[+-]\d+)?|\brolls?\s+\d+\b|\b(?:HIT|MISS|damage|attack)\b)/gi);
          if (rollMatches && rollMatches.length > 0) {
            console.log(`🎲 DICE & COMBAT:`);
            rollMatches.forEach(m => console.log(`   • ${m}`));
            console.log('');
          }
        }

        // Progress indicator
        process.stdout.write('.');
        if (sessionTurns % 5 === 0) {
          process.stdout.write(`[${sessionTurns}]`);
        }
        currentLevel = 1 + Math.floor(totalTurns / turnsPerLevel);
        if (currentLevel >= targetLevel) break;
      }

      await page.waitForTimeout(250);
    }

    console.log(`\n\n✅ Session complete: ${sessionTurns} turns`);
    currentLevel = 1 + Math.floor(totalTurns / turnsPerLevel);
    if (currentLevel < targetLevel && (sessionTurns === 0 || noActionCount >= maxNoAction)) {
      const diagnostics = await getActionResponseDiagnostics(page, 0);
      throw new Error(`Campaign session stalled before reaching target level. session=${gameCount}, sessionTurns=${sessionTurns}, noActionCount=${noActionCount}, totalTurns=${totalTurns}, level=${currentLevel}/${targetLevel}\n${diagnostics}`);
    }
    console.log(`📊 Total turns: ${totalTurns} | Current level: ${currentLevel}/${targetLevel}\n`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🎉 CAMPAIGN COMPLETE!`);
  console.log(`📈 Total Sessions: ${gameCount}`);
  console.log(`📊 Total Turns: ${totalTurns}`);
  console.log(`🏅 Final Level: ${currentLevel}`);
  console.log(`${'═'.repeat(70)}\n`);

  expect(currentLevel).toBeGreaterThanOrEqual(targetLevel);
});
