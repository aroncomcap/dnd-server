# ⚔️ Tavern Table — Multiplayer D&D with Claude as DM

A real-time multiplayer Dungeons & Dragons 5e experience where Claude serves as your AI Dungeon Master. Players connect from their phones and take turns, with a 3-minute timer per turn.

## Features
- **Shared live chat** — all players see the DM narration in real time
- **Turn-based play** with a 3-minute countdown per player
- **Auto-action** — if a player doesn't respond, Claude acts for them based on their personality and standard actions
- **Persistent characters** — character stats and chat history survive server restarts
- **Mobile-first UI** — designed for phones

---

## Setup

### 1. Prerequisites
- Node.js 18+
- An Anthropic API key (https://console.anthropic.com)

### 2. Install
```bash
cd dnd-server
npm install
```

### 3. Set your API key
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```
Or create a `.env` file and use `dotenv`.

### 4. Run
```bash
npm start
# Server starts on http://localhost:3000
```

---

## How to Play

### Host setup
1. Open `http://your-server-ip:3000` on any device
2. Go to **Character** tab — register your character (name, class, stats, personality, standard actions)
3. Go to **Host** tab — optionally write an opening scene, then tap **Begin the Adventure**

### Players join
- Each player opens the same URL on their phone
- Goes to **Character** tab and registers their character
- Returns to **Game** tab to watch the story unfold

### Taking turns
- The current player's name appears in the banner at the top
- Type your action in the text box and tap **Send Action**
- Tap **⚡ Quick** to pick from your pre-defined standard actions
- If you don't act within 3 minutes, Claude will act for you

---

## Deploying publicly (so anyone can join)

### Option A: ngrok (quick, free)
```bash
npm start
# In another terminal:
npx ngrok http 3000
# Share the ngrok URL with your players
```

### Option B: Railway / Render / Fly.io
Push the `dnd-server` folder to GitHub, then deploy as a Node.js app. Set `ANTHROPIC_API_KEY` in environment variables.

### Option C: VPS (DigitalOcean, etc.)
```bash
scp -r dnd-server user@your-server:~/
ssh user@your-server
cd dnd-server && npm install && ANTHROPIC_API_KEY=sk-ant-... npm start
```

---

## File structure
```
dnd-server/
├── server.js          # Express + Socket.io + Anthropic
├── package.json
├── game_data.json     # Auto-created, persists characters & chat
└── public/
    └── index.html     # Mobile-first web client
```

---

## Tips
- **Character standard actions** — comma-separate them: `Attack nearest enemy, Dodge, Cast Fireball`
- **Personality field** — be descriptive: Claude uses this to make decisions when acting for a player
- Game state resets wipe chat history but **preserve all registered characters**
- The server keeps the last 80 messages in context to stay within Claude's limits
