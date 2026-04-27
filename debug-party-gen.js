const fetch = require('node-fetch') || require('node:fetch');

const BASE_URL = 'https://theystillsing.com';

const TEST_USER = {
  email: 'test-bot-1@theystillsing.test',
  password: 'TestPassword12345!@#',
};

let authToken = null;

async function authenticate() {
  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: TEST_USER.email,
      password: TEST_USER.password,
    }),
    credentials: 'include',
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie && setCookie.includes('tt_token=')) {
    const match = setCookie.match(/tt_token=([^;]+)/);
    authToken = match ? match[1] : null;
  }
  return !!authToken;
}

async function createGame() {
  const response = await fetch(`${BASE_URL}/api/games`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `tt_token=${authToken}`,
    },
    body: JSON.stringify({
      name: `Debug-Party-${Date.now()}`,
      system: 'dnd5e',
    }),
  });

  if (!response.ok) return null;
  const game = await response.json();
  return game.id;
}

async function main() {
  if (!await authenticate()) {
    console.log('Auth failed');
    return;
  }

  const gameId = await createGame();
  console.log(`Game created: ${gameId}`);

  // Make HTTP request to trigger party generation
  const response = await fetch(`${BASE_URL}/api/games/${gameId}/generate-party`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `tt_token=${authToken}`,
    },
    body: JSON.stringify({
      direction: 'Small elite party - 2 characters. Fighter and Cleric. Level 1.',
    }),
  });

  const result = await response.json();
  console.log('Party generation result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
