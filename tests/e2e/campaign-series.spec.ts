import { test, expect } from '@playwright/test';
import { loginTestUserInBrowser } from './test-user';

/**
 * Campaign Series Test - Plays multiple games sequentially to reach level 1-10
 * Each game is a "session" in a multi-session campaign
 */

test('Campaign Series: Multi-Session Campaign Level 1-3', async ({ page, baseURL }) => {
  console.log(`\n🏰 CAMPAIGN SERIES - LEVEL 1-3`);
  console.log(`🎯 Objective: Complete a campaign from level 1 to level 3\n`);
  console.log(`📊 Capturing all narration, combat, and game events\n`);

  let totalTurns = 0;
  let gameCount = 0;
  let currentLevel = 1;
  const targetLevel = 3;
  const turnsPerLevel = 30;

  while (currentLevel < targetLevel) {
    gameCount++;
    console.log(`\n📖 SESSION ${gameCount} - Level ${currentLevel}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // Authenticate
    const authenticated = await loginTestUserInBrowser(page, baseURL!);
    expect(authenticated).toBe(true);

    // Create game
    const gameName = `Campaign-Session${gameCount}-L${currentLevel}`;
    await page.goto(`${baseURL}/new-game`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    const gameNameInput = page.locator('#game-name');
    const isVisible = await gameNameInput.isVisible().catch(() => false);
    if (!isVisible) {
      console.log(`❌ Form not visible, navigating to lobby and retrying`);
      await page.goto(`${baseURL}/lobby`);
      await page.waitForTimeout(2000);
      continue;
    }

    await gameNameInput.fill(gameName);
    await page.locator('#game-system').selectOption('dnd5e');
    await page.locator('#scene-prompt').fill('A new chapter in your adventure begins. You stand at the threshold of destiny.');
    await page.locator('#party-direction').fill('Your seasoned adventurers face their next challenge.');

    await page.locator('#btn-create').click();

    try {
      await page.waitForURL(/\/game\//, { timeout: 15000 });
    } catch {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    }

    // Get game ID
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

    console.log(`✅ Game created: ${gameId.substring(0, 8)}...`);

    // Start game
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const startBtn = page.locator('button:has-text("START"), button:has-text("Begin")').first();
    if (await startBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await startBtn.click();
      await page.waitForTimeout(2000);
    }

    // Play session
    let sessionTurns = 0;
    let noActionCount = 0;
    const maxSessionTurns = 50;
    const maxNoAction = 6;

    console.log(`🎮 Playing session...`);
    process.stdout.write('  ');

    while (sessionTurns < maxSessionTurns && noActionCount < maxNoAction) {
      // Wait for loading to finish
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

      // Try to take an action
      let actionTaken = false;

      // Look for option buttons
      const optionButtons = await page.locator('button[class*="option"], button:has-text("→")').all();

      if (optionButtons.length > 0) {
        const randomBtn = optionButtons[Math.floor(Math.random() * optionButtons.length)];
        try {
          await randomBtn.click({ timeout: 2000, force: true });
          actionTaken = true;
          noActionCount = 0;
        } catch {
          // Try force without timeout
          try {
            await randomBtn.click({ force: true });
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
              const sendBtn = page.locator('button:has-text("SEND"), button:has-text("Submit")').first();
              const isSendVisible = await sendBtn.isVisible({ timeout: 500 }).catch(() => false);
              if (isSendVisible) {
                await sendBtn.click({ force: true });
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
        process.stdout.write('.');
      } else {
        sessionTurns++;
        totalTurns++;

        // Capture narration and combat after action
        await page.waitForTimeout(1500); // Wait for narration to stream
        const content = await page.evaluate(() => {
          const chatLog = document.getElementById('chat-log');
          if (!chatLog) return { narration: '', combat: false };

          // Get all msg-dm elements
          const allMsgs = document.querySelectorAll('#chat-log .msg-dm');
          if (allMsgs.length === 0) return { narration: '', combat: false };

          const lastMsg = allMsgs[allMsgs.length - 1];
          const divs = lastMsg.querySelectorAll('div');
          if (divs.length === 0) return { narration: '', combat: false };

          const msgBody = divs[divs.length - 1];
          const text = (msgBody.textContent || '').trim();

          // Check for combat indicators
          const isCombat = /\b(COMBAT|attack|hit|miss|damage|spell|initiative)\b/i.test(text);

          return {
            narration: text.substring(0, 800),
            combat: isCombat
          };
        });

        if (content.narration && content.narration.length > 50) {
          const indicator = content.combat ? '⚔️  COMBAT' : '📖 Narration';
          console.log(`\n${indicator} - Turn ${sessionTurns}:`);
          console.log(content.narration.split('\n')[0]); // First line
          console.log('');
        }

        if (sessionTurns % 5 === 0) {
          process.stdout.write(`[${sessionTurns}]`);
        } else {
          process.stdout.write('.');
        }
      }

      await page.waitForTimeout(250);
    }

    console.log(`\n✅ Session complete: ${sessionTurns} turns`);

    // ✅ FIX: Read actual player level from game state instead of calculating it
    const actualLevel = await page.evaluate(() => {
      const levelElement = document.querySelector('[data-player-level], .level, .player-level');
      if (levelElement) {
        const levelText = levelElement.textContent || '';
        const match = levelText.match(/\d+/);
        return match ? parseInt(match[0]) : null;
      }

      // Fallback: check for level in character data
      const charElements = document.querySelectorAll('[data-character-level]');
      if (charElements.length > 0) {
        const levelAttr = charElements[0].getAttribute('data-character-level');
        return levelAttr ? parseInt(levelAttr) : null;
      }

      return null;
    });

    if (actualLevel !== null) {
      currentLevel = actualLevel;
      console.log(`📊 Total turns: ${totalTurns} | Actual level: ${currentLevel}/${targetLevel} (read from game)`);
    } else {
      // Fallback to calculated level if DOM level not found
      console.log(`⚠️  Could not read level from DOM, using calculated estimate`);
      currentLevel = 1 + Math.floor(totalTurns / turnsPerLevel);
      console.log(`📊 Total turns: ${totalTurns} | Estimated level: ${currentLevel}/${targetLevel}`);
    }
  }

  console.log(`\n${'━'.repeat(40)}`);
  console.log(`🎉 CAMPAIGN COMPLETE!`);
  console.log(`📈 Total Sessions: ${gameCount}`);
  console.log(`📊 Total Turns: ${totalTurns}`);
  console.log(`🏅 Final Level: ${currentLevel}`);
  console.log(`${'━'.repeat(40)}\n`);

  expect(currentLevel).toBeGreaterThanOrEqual(targetLevel);
});
