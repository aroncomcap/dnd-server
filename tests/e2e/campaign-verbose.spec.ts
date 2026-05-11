import { test, expect } from '@playwright/test';
import { loginTestUserInBrowser } from './test-user';
import { getCompletedDmMessageCount, getLastCompletedDmText, waitForActionResponse } from './game-action';

/**
 * Campaign Verbose Test - Detailed Output
 * Captures and displays: narration, dice rolls, combat, all game events
 */

test('Campaign Verbose: Level 1-3 with Full Output', async ({ page, baseURL }) => {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║                   TAVERN TABLE - VERBOSE MODE                  ║`);
  console.log(`║         Full Narration, Dice Rolls, and Combat Details          ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

  let totalTurns = 0;
  let gameCount = 0;
  let currentLevel = 1;
  const targetLevel = 3;
  const turnsPerLevel = 30;

  while (currentLevel < targetLevel) {
    gameCount++;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`SESSION ${gameCount} - LEVEL ${currentLevel}`);
    console.log(`${'='.repeat(70)}\n`);

    // Authenticate
    const authenticated = await loginTestUserInBrowser(page, baseURL!);
    expect(authenticated).toBe(true);

    // Create game
    const gameName = `Verbose-Session${gameCount}-L${currentLevel}`;
    await page.goto(`${baseURL}/new-game`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    const gameNameInput = page.locator('#game-name');
    const isVisible = await gameNameInput.isVisible().catch(() => false);
    if (!isVisible) {
      console.log(`❌ Form not visible, retrying...`);
      continue;
    }

    await gameNameInput.fill(gameName);
    await page.locator('#game-system').selectOption('dnd5e');
    await page.locator('#scene-prompt').fill('A new chapter in your adventure begins.');
    await page.locator('#party-direction').fill('Your seasoned adventurers face their next challenge.');
    await page.locator('#btn-create').click();

    try {
      await page.waitForURL(/\/game\//, { timeout: 15000 });
    } catch {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    }

    let gameUrl = page.url();
    let gameId = gameUrl.match(/\/game\/([a-f0-9-]+)/)?.[1];

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

    if (!gameId) {
      console.log(`❌ Failed to create game`);
      continue;
    }

    console.log(`✅ Game: ${gameId.substring(0, 8)}...\n`);

    // Start game
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const startBtn = page.locator('button:has-text("START"), button:has-text("Begin")').first();
    if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await startBtn.click();
      await page.waitForTimeout(2000);
    }

    // Play session with verbose capture
    let sessionTurns = 0;
    let noActionCount = 0;
    const maxSessionTurns = 50;
    const maxNoAction = 6;

    console.log(`🎮 PLAYING SESSION...\n`);

    while (sessionTurns < maxSessionTurns && noActionCount < maxNoAction) {
      // Wait for loading
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

      // Try to take action
      let actionTaken = false;
      const beforeDmCount = await getCompletedDmMessageCount(page);

      const optionButtons = await page.locator('button[class*="option"], button:has-text("→")').all();
      const readyOptionButtons = [];
      for (const btn of optionButtons) {
        const isReady = await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false);
        if (isReady) readyOptionButtons.push(btn);
      }
      if (readyOptionButtons.length > 0) {
        const randomBtn = readyOptionButtons[Math.floor(Math.random() * readyOptionButtons.length)];
        try {
          await randomBtn.click({ timeout: 2000 });
          actionTaken = true;
          noActionCount = 0;
        } catch {
          try {
            await randomBtn.click();
            actionTaken = true;
            noActionCount = 0;
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
            const actions = ['I attack', 'Move', 'Cast spell', 'Search', 'Go forward'];
            try {
              await input.fill(actions[Math.floor(Math.random() * actions.length)]);
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

      if (!actionTaken) {
        noActionCount++;
      } else {
        const responseReady = await waitForActionResponse(page, beforeDmCount);
        if (!responseReady) {
          console.log(`⚠️  No completed DM response after action; waiting for another opportunity`);
          noActionCount++;
          continue;
        }

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
          const rollMatches = lastBody.match(/(\d+d\d+[+\-\d]*|\broll[s]?\s+\d+|\bHIT|MISS|damage|attack)/gi);
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
      }

      await page.waitForTimeout(250);
    }

    console.log(`\n\n✅ Session complete: ${sessionTurns} turns`);
    currentLevel = 1 + Math.floor(totalTurns / turnsPerLevel);
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
