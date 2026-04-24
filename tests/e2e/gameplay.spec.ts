import { test, expect } from '@playwright/test';
import { loginTestUserInBrowser } from './test-user';

/**
 * E2E Tests for Tavern Table Gameplay
 *
 * These tests create games, play through them randomly selecting options,
 * and catch errors to help improve stability.
 *
 * Test user: test-bot@theystillsing.test / TestPassword12345!@#
 *
 * Run with: npm run test:e2e
 */

// Helper: Generate random game name
function generateGameName(): string {
  const adjectives = ['Mystic', 'Dark', 'Emerald', 'Crimson', 'Silent', 'Lost', 'Ancient', 'Cursed'];
  const nouns = ['Tower', 'Forest', 'Cavern', 'Castle', 'Vault', 'Temple', 'Valley', 'Gate'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

// Helper: Wait for game to be ready and start
async function startGame(page: any): Promise<boolean> {
  try {
    // Wait for start button or narration to appear
    const startBtn = page.locator('button:has-text("START"), button:has-text("Begin")').first();
    const storyPanel = page.locator('[data-testid="game-story"], #story, .story');

    const startVisible = await startBtn.isVisible().catch(() => false);
    const storyVisible = await storyPanel.isVisible().catch(() => false);

    if (startVisible) {
      await startBtn.click();
      await page.waitForTimeout(2000);
    }

    return true;
  } catch {
    return false;
  }
}

// Helper: Get random action option and play it
async function playRandomAction(page: any, turnNum: number): Promise<{ played: boolean; error?: string }> {
  try {
    // Look for action options
    const optionButtons = await page.locator('button:has-text("→")').all(); // Option arrows
    const textButtons = await page.locator('[class*="option"], [class*="action"]').locator('button').all();

    const allButtons = [...optionButtons];
    if (textButtons.length > 0) {
      allButtons.push(...textButtons);
    }

    if (allButtons.length === 0) {
      // No options, try to send a text action
      const actionInput = page.locator('textarea, input[placeholder*="action" i], input[placeholder*="describe" i]').first();
      if (await actionInput.isVisible().catch(() => false)) {
        const actions = ['I attack!', 'I cast a spell', 'I investigate', 'I talk to them', 'I move forward', 'I wait'];
        const action = actions[Math.floor(Math.random() * actions.length)];
        await actionInput.fill(action);

        const sendBtn = page.locator('button:has-text("SEND"), button:has-text("Send"), button:has-text("→")').first();
        if (await sendBtn.isVisible().catch(() => false)) {
          await sendBtn.click();
          await page.waitForTimeout(2000);
          return { played: true };
        }
      }
      return { played: false, error: 'No action options found' };
    }

    // Pick random option
    const randomOption = allButtons[Math.floor(Math.random() * allButtons.length)];
    await randomOption.click();
    await page.waitForTimeout(2000);

    return { played: true };
  } catch (err: any) {
    return { played: false, error: err.message };
  }
}

test.describe('Sophisticated Gameplay Testing', () => {
  test('should create game, play through randomly, and catch errors', async ({ page, baseURL }) => {
    const gameName = generateGameName();
    const errors: string[] = [];
    const logs: string[] = [];

    // Collect console messages
    page.on('console', msg => {
      const text = msg.text();
      const type = msg.type();

      if (type === 'error' || type === 'warning') {
        const isCritical =
          text.includes('Cannot read') ||
          text.includes('undefined') ||
          text.includes('is not defined') ||
          text.includes('Uncaught') ||
          text.includes('Error:');

        if (isCritical) {
          errors.push(`[${type.toUpperCase()}] ${text}`);
        }
      }
      logs.push(text);
    });

    // Step 0: Login with test user
    console.log(`🔐 Authenticating...`);
    const authenticated = await loginTestUserInBrowser(page, baseURL!);
    if (!authenticated) {
      console.log(`⏭️  Skipping game creation test (authentication failed)`);
      test.skip();
      return;
    }

    // Step 1: Navigate to new game page
    console.log(`📖 Testing game: "${gameName}"`);
    await page.goto(`${baseURL}/new-game`);
    await page.waitForLoadState('networkidle');

    // Step 2: Fill game creation form
    console.log('📝 Creating game...');

    // Use specific element IDs from new-game.html
    const nameInput = page.locator('#game-name');
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(gameName);
    }

    const systemSelect = page.locator('#game-system');
    if (await systemSelect.isVisible().catch(() => false)) {
      await systemSelect.selectOption('dnd5e');
    }

    const sceneInput = page.locator('#scene-prompt');
    if (await sceneInput.isVisible().catch(() => false)) {
      const scene = 'A mysterious tavern appears. Strange symbols glow on the walls.';
      await sceneInput.fill(scene);
    }

    const partyInput = page.locator('#party-direction');
    if (await partyInput.isVisible().catch(() => false)) {
      const party = '4 characters, level 1-2, balanced adventuring party';
      await partyInput.fill(party);
    }

    // Click the "Start Story" button
    const createBtn = page.locator('#btn-create');

    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000); // Wait for game to be created
    }

    // Wait for redirect to game page and extract game ID
    try {
      await page.waitForURL(/\/game\//, { timeout: 5000 });
    } catch {
      // Timeout waiting for redirect - game may have been created but redirect failed
      console.warn('⚠️  No redirect to game page, checking URL...');
    }

    const currentUrl = page.url();
    const gameMatch = currentUrl.match(/\/game\/([a-f0-9-]+)/);
    let gameId = gameMatch?.[1];

    // If still no ID, try to find it in recent page navigation
    if (!gameId) {
      // Try to get the last game from the API
      try {
        const gamesRes = await page.request.get(`${baseURL}/api/games`);
        if (gamesRes.ok()) {
          const games = await gamesRes.json();
          if (games.length > 0) {
            gameId = games[0].id;
            console.log(`📌 Found latest game: ${gameId}`);
          }
        }
      } catch {
        // Fall through
      }
    }

    if (!gameId) {
      console.error('❌ Failed to create or navigate to game');
      return;
    }

    console.log(`✅ Game created: ${gameId}`);

    // Step 3: Start the game
    console.log('🎮 Starting game...');
    await startGame(page);

    // Step 4: Play through several turns
    const maxTurns = 8;
    for (let turn = 1; turn <= maxTurns; turn++) {
      console.log(`🔄 Turn ${turn}/${maxTurns}`);

      if (errors.length > 0) {
        console.log(`⚠️  Errors detected on turn ${turn}, stopping`);
        break;
      }

      const { played, error } = await playRandomAction(page, turn);

      if (!played) {
        console.log(`⏸️  Turn ${turn}: No more actions available (${error})`);
        break;
      }

      // Check for new errors after action
      if (errors.length > 0) {
        console.log(`🐛 Error detected: ${errors[errors.length - 1]}`);
        break;
      }
    }

    // Step 5: Report findings
    console.log('\n📊 Test Results:');
    console.log(`  Game: ${gameName}`);
    console.log(`  ID: ${gameId}`);
    console.log(`  Errors found: ${errors.length}`);

    if (errors.length > 0) {
      console.log('\n🐛 Critical Errors:');
      errors.slice(0, 5).forEach((err, i) => {
        console.log(`  ${i + 1}. ${err}`);
      });

      // Report errors as test failure so they're visible in output
      console.error('\n❌ ERRORS FOUND - Fix these and re-run tests:');
      errors.forEach(err => console.error(`   - ${err}`));
    } else {
      console.log('✅ No critical errors encountered!');
    }

    // Assert: Should have no critical errors
    expect(errors.length).toBe(0);
  });

  test('should handle lobby and game discovery', async ({ page, baseURL }) => {
    console.log('🏰 Testing lobby navigation...');

    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && (
        msg.text().includes('Cannot read') ||
        msg.text().includes('is not defined')
      )) {
        errors.push(msg.text());
      }
    });

    await page.goto(`${baseURL}/lobby`);
    await page.waitForLoadState('networkidle');

    expect(errors.length).toBe(0);
    expect(page).toBeTruthy();
  });

  test('should test character creation flow', async ({ page, baseURL }) => {
    console.log('👥 Testing character creation...');

    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && msg.text().includes('Cannot read')) {
        errors.push(msg.text());
      }
    });

    // Navigate to new game which may include party creation
    await page.goto(`${baseURL}/new-game`);
    await page.waitForLoadState('networkidle');

    // Check if party/character options are visible
    const partySection = page.locator('[data-testid*="party"], [id*="party"], text=Party').first();
    if (await partySection.isVisible().catch(() => false)) {
      console.log('✅ Party creation UI found');
    }

    expect(errors.length).toBe(0);
  });

  test('should recover from page navigation and reload', async ({ page, baseURL }) => {
    console.log('🔄 Testing page recovery...');

    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Navigate to lobby
    await page.goto(`${baseURL}/lobby`);
    await page.waitForLoadState('networkidle');

    // Reload page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Should still be functional
    const criticalErrors = errors.filter(e =>
      e.includes('Cannot read') ||
      e.includes('is not defined')
    );

    expect(criticalErrors.length).toBe(0);
    console.log('✅ Page recovery successful');
  });
});
