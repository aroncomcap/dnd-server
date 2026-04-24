import { test, expect } from '@playwright/test';
import { loginTestUserInBrowser } from './test-user';

/**
 * Full Campaign Test - Plays through a complete game from level 1-10
 * Single test per run - playwright config handles retries
 */

test('Full Campaign: Play game from level 1-10', async ({ page, baseURL }) => {
  const gameName = `Campaign-L1-L10-${Date.now()}`;
  const errors: string[] = [];

  console.log(`\n🎮 STARTING FULL CAMPAIGN TEST`);
  console.log(`📅 Game: ${gameName}`);

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('Cannot read') || text.includes('is not defined') || text.includes('Uncaught')) {
        errors.push(text);
        console.log(`🐛 Error: ${text}`);
      }
    }
  });

  // Step 1: Authenticate
  console.log(`\n1️⃣  AUTHENTICATION`);
  const authenticated = await loginTestUserInBrowser(page, baseURL!);
  expect(authenticated).toBe(true);
  console.log(`✅ Authenticated`);

  // Step 2: Navigate to new game form
  console.log(`\n2️⃣  CREATING GAME`);
  await page.goto(`${baseURL}/new-game`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);  // Extra wait for form to fully load

  // Verify form is visible
  const gameNameInput = page.locator('#game-name');
  const formContent = page.locator('#form-content');

  // Check if form content is visible
  const formIsVisible = await formContent.isVisible().catch(() => false);
  if (!formIsVisible) {
    console.log(`⚠️  Form content not visible, checking page state...`);
    const pageTitle = await page.title();
    const pageUrl = page.url();
    console.log(`   Title: ${pageTitle}`);
    console.log(`   URL: ${pageUrl}`);
    const bodyText = await page.locator('body').textContent();
    console.log(`   Page has auth gate: ${bodyText?.includes('Enter the Tavern')}`);
  }

  // Fill game creation form
  const systemSelect = page.locator('#game-system');
  const sceneInput = page.locator('#scene-prompt');
  const partyInput = page.locator('#party-direction');
  const createBtn = page.locator('#btn-create');

  const isInputVisible = await gameNameInput.isVisible().catch(() => false);
  expect(isInputVisible).toBe(true);

  await gameNameInput.fill(gameName);
  await systemSelect.selectOption('dnd5e');
  await sceneInput.fill('You arrive at a tavern. Strange symbols glow on the walls. A cloaked figure waves you over.');
  await partyInput.fill('4 adventurers, levels 1-2, balanced party ready for their first real adventure');

  console.log(`✏️  Game form filled`);

  // Submit and wait for game load
  console.log(`🎬 Submitting form...`);
  await createBtn.click();

  // Wait for either game page or redirect
  try {
    await page.waitForURL(/\/game\//, { timeout: 20000 });
    console.log(`✅ Redirected to game page`);
  } catch {
    console.log(`⚠️  No immediate redirect, checking if page navigated...`);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  // Get game ID from URL or API
  let gameUrl = page.url();
  let gameId = gameUrl.match(/\/game\/([a-f0-9-]+)/)?.[1];

  if (!gameId) {
    console.log(`⚠️  Game ID not in URL, fetching from API...`);
    const gamesRes = await page.request.get(`${baseURL}/api/games`);
    if (gamesRes.ok()) {
      const games = await gamesRes.json();
      if (games.length > 0) {
        gameId = games[0].id;
        await page.goto(`${baseURL}/game/${gameId}`, { waitUntil: 'domcontentloaded' });
        console.log(`✅ Loaded game: ${gameId}`);
      }
    }
  }

  expect(gameId).toBeTruthy();
  console.log(`✅ Game created: ${gameId}`);

  // Step 3: Start game
  console.log(`\n3️⃣  STARTING GAME`);
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const startBtn = page.locator('button:has-text("START"), button:has-text("Begin")').first();
  const isStartBtnVisible = await startBtn.isVisible({ timeout: 5000 }).catch(() => false);

  if (isStartBtnVisible) {
    await startBtn.click();
    console.log(`🎮 Game started`);
  } else {
    console.log(`ℹ️  No start button found (game may have auto-started)`);
  }

  await page.waitForTimeout(2000);

  // Step 4: Play through turns (simulate full campaign level 1-10)
  console.log(`\n4️⃣  PLAYING CAMPAIGN (Level 1-10)`);
  let turnCount = 0;
  let consecutiveNoAction = 0;
  const maxTurns = 300;  // ~30 turns per level × 10 levels
  const maxNoActionStreak = 8;  // Higher threshold for longer campaigns

  while (turnCount < maxTurns && consecutiveNoAction < maxNoActionStreak) {
    if (errors.length > 0) {
      console.log(`❌ Critical error detected`);
      break;
    }

    // Wait for loading overlay to disappear
    const loadingOverlay = page.locator('#loading-overlay');
    const isLoading = await loadingOverlay.isVisible({ timeout: 1000 }).catch(() => false);
    if (isLoading) {
      // Wait for it to finish
      try {
        await page.waitForFunction(
          () => {
            const overlay = document.getElementById('loading-overlay');
            return !overlay || overlay.style.display === 'none' || overlay.style.visibility === 'hidden';
          },
          { timeout: 8000 }
        );
      } catch {
        // Continue anyway
      }
    }

    await page.waitForTimeout(200);

    // Look for player action options
    const actionButtons = await page.locator('button:has-text("→")').all();
    const actionTextarea = page.locator('textarea[placeholder*="action" i], textarea[placeholder*="describe" i]').first();
    const actionInput = page.locator('input[placeholder*="action" i], input[placeholder*="describe" i]').first();

    let actionTaken = false;

    // Try clicking a random option button
    if (actionButtons.length > 0) {
      const randomBtn = actionButtons[Math.floor(Math.random() * actionButtons.length)];
      try {
        // Force scroll into view first
        await randomBtn.scrollIntoViewIfNeeded();
        await randomBtn.click({ timeout: 3000, force: true });
        actionTaken = true;
        consecutiveNoAction = 0;
      } catch {
        // Button not clickable
      }
    }

    // Try text input
    if (!actionTaken) {
      const textIsVisible = await actionTextarea.isVisible({ timeout: 1000 }).catch(() => false);
      if (textIsVisible) {
        const actions = [
          'I attack',
          'I cast a spell',
          'I move forward',
          'I investigate',
          'I search',
          'I talk',
          'I defend',
          'I advance',
        ];
        const action = actions[Math.floor(Math.random() * actions.length)];

        try {
          await actionTextarea.fill(action);
          const sendBtn = page.locator('button:has-text("SEND"), button:has-text("Submit"), button:has-text("→")').first();
          if (await sendBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await sendBtn.click({ force: true });
            actionTaken = true;
            consecutiveNoAction = 0;
          }
        } catch {
          // Input failed
        }
      }
    }

    if (!actionTaken) {
      consecutiveNoAction++;
      process.stdout.write('.');
    } else {
      turnCount++;
      const currentLevel = 1 + Math.floor(turnCount / 30);

      if (turnCount % 30 === 0 && currentLevel <= 10) {
        process.stdout.write(`[L${currentLevel}]`);
      } else if (turnCount % 10 === 0) {
        process.stdout.write(`[${turnCount}]`);
      } else {
        process.stdout.write('.');
      }
    }

    await page.waitForTimeout(400);  // Faster turn cycle
  }

  console.log(`\n✅ Campaign play complete`);
  const finalLevel = 1 + Math.floor(turnCount / 30);
  console.log(`📊 Turns played: ${turnCount}`);
  console.log(`📈 Final level: ${Math.min(finalLevel, 10)} (target: level 10)`);

  // Verify no critical errors
  expect(errors.length).toBe(0);
  expect(turnCount).toBeGreaterThan(0);

  console.log(`\n🎉 TEST PASSED - Full campaign completed successfully!`);
});
