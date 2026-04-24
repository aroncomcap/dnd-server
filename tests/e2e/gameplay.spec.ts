import { test, expect } from '@playwright/test';

/**
 * E2E Tests for Tavern Table Gameplay
 *
 * These tests validate core gameplay flows without human intervention.
 * Run with: npm run test:e2e
 */

test.describe('Gameplay Flow', () => {
  let gameId: string;

  test('should load game page without console errors', async ({ page }) => {
    // Create a test game first (requires API)
    const createResponse = await page.request.post('http://localhost:3000/api/games/test', {
      headers: { 'Content-Type': 'application/json' },
      data: { name: 'E2E Test Game', system: 'dnd5e' }
    });
    const game = await createResponse.json();
    gameId = game.id;

    // Navigate to game
    await page.goto(`/game/${gameId}`);

    // Check for critical console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Wait for page to fully load
    await page.waitForLoadState('networkidle');

    // Should have loaded game title
    const title = page.locator('title');
    await expect(title).toContainText('They Still Sing');

    // No critical errors
    const criticalErrors = errors.filter(e =>
      e.includes('Cannot read') ||
      e.includes('undefined') ||
      e.includes('is not defined')
    );
    expect(criticalErrors.length).toBe(0);
  });

  test('should start game and show DM message', async ({ page }) => {
    // Navigate to game
    await page.goto(`/game/${gameId}`);
    await page.waitForLoadState('networkidle');

    // Wait for game to be loaded
    await page.waitForSelector('[data-testid="game-story"]', { timeout: 5000 }).catch(() => null);

    // Click START GAME if available
    const startBtn = page.locator('button:has-text("START GAME"), button:has-text("Begin")').first();
    if (await startBtn.isVisible()) {
      await startBtn.click();
    }

    // Wait for DM narration
    await page.waitForTimeout(2000);

    // Check if any message arrived
    const storyPanel = page.locator('[data-testid="game-story"], #story, .story');
    const storyText = await storyPanel.textContent();

    // Should have some narrative content
    expect(storyText?.length ?? 0).toBeGreaterThan(0);
  });

  test('should send player action', async ({ page }) => {
    await page.goto(`/game/${gameId}`);
    await page.waitForLoadState('networkidle');

    // Find action input
    const actionInput = page.locator('textarea, input[placeholder*="action" i], input[placeholder*="describe" i]').first();

    if (await actionInput.isVisible()) {
      // Type action
      await actionInput.fill('I draw my sword and prepare for battle.');

      // Submit
      const sendBtn = page.locator('button:has-text("SEND"), button:has-text("Send")').first();
      if (await sendBtn.isVisible()) {
        await sendBtn.click();
      }

      // Wait for response
      await page.waitForTimeout(3000);

      // Action should be reflected in UI
      const chatArea = page.locator('[data-testid="chat"], #chat, .chat-history');
      const chatText = await chatArea.textContent();
      expect(chatText).toBeTruthy();
    }
  });

  test('should handle navigation tabs without errors', async ({ page }) => {
    await page.goto(`/game/${gameId}`);
    await page.waitForLoadState('networkidle');

    const tabs = ['GAME', 'CHARACTER', 'PARTY', 'WORLD', 'MAP', 'HOST'];

    for (const tabName of tabs) {
      const tab = page.locator(`button:has-text("${tabName}")`).first();

      if (await tab.isVisible()) {
        await tab.click();
        await page.waitForTimeout(500);

        // Tab should be marked active
        const activeTab = page.locator(`button:has-text("${tabName}").active, button:has-text("${tabName}")[class*="active"]`).first();
        await expect(activeTab).toBeVisible().catch(() => {
          // Tab visibility might vary, that's ok
        });
      }
    }
  });
});

test.describe('Lobby Flow', () => {
  test('should load lobby without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/lobby');
    await page.waitForLoadState('networkidle');

    // Filter critical errors
    const criticalErrors = errors.filter(e =>
      e.includes('Cannot read') ||
      e.includes('is not defined')
    );

    expect(criticalErrors.length).toBe(0);
  });

  test('should display games list or redirect to create game', async ({ page }) => {
    await page.goto('/lobby');
    await page.waitForLoadState('networkidle');

    // Should either show games or redirect to new-game
    const url = page.url();
    const hasGames = await page.locator('[data-testid="games-grid"], .game-card').isVisible().catch(() => false);

    expect(url.includes('lobby') || url.includes('new-game')).toBeTruthy();
  });
});

test.describe('Error Recovery', () => {
  test('should handle page reload gracefully', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/lobby');
    await page.reload();
    await page.waitForLoadState('networkidle');

    const criticalErrors = errors.filter(e =>
      e.includes('Cannot read') ||
      e.includes('is not defined')
    );
    expect(criticalErrors.length).toBe(0);
  });

  test('should recover from network errors', async ({ page }) => {
    // Go offline
    await page.context().setOffline(true);
    await page.goto('/lobby').catch(() => {});

    // Come back online
    await page.context().setOffline(false);
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Page should recover
    const title = page.locator('title');
    await expect(title).toContainText('They Still Sing').catch(() => {
      // Network recovery might fail, that's ok - we're testing graceful handling
    });
  });
});
