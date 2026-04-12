# Help & FAQ Page Design

## Overview

Combined explainer + help reference page at `/help`. Top half is a narrative walkthrough of Tavern Table (structured to double as a video script). Bottom half is a collapsible FAQ accordion grouped by topic. Same parchment/dark fantasy aesthetic as all other pages.

## Route

- `GET /help` → `public/help.html`
- Add "Help" link to landing page nav (next to "Login")
- Add "Help" link to lobby page

## Page Structure

### Explainer Section (Top Half)

Structured as short, readable sections that flow naturally as a script if narrated over gameplay footage.

**1. What is Tavern Table?**
An AI Dungeon Master that runs your tabletop RPG in real time. No prep, no scheduling, no rulebook lookup. Create a game, bring friends (or play solo), and the AI handles everything — narration, NPCs, combat, dice rolls, maps, and scene images.

**2. How a Game Works**
Step-by-step walkthrough:
1. Create a game — pick a name and system (D&D 5e, RuneQuest, or custom)
2. Create your character — write stats from scratch, paste a character sheet, or upload a PDF
3. Hit "Begin Adventure" — the AI sets the scene
4. Choose actions — pick from suggested options or type anything you can imagine
5. The story unfolds — the AI narrates, rolls dice, tracks combat, generates images, and draws your map

**3. What Can You Do?**
- Fight monsters, explore dungeons, negotiate with NPCs
- Upload any RPG sourcebook as a PDF — the AI learns your world
- Play from the web or directly in Discord
- Adjust difficulty, verbosity, DM personality, and exploration/combat/social balance
- Share a game link and play with friends in real time

**4. Pricing**
- 10 free hours to start
- 5 free hours every month after that
- Need more? $1/hour (bulk discounts: $4.50/5hr, $15/20hr)

### FAQ Section (Bottom Half)

Collapsible accordion — gold headers on dark parchment, expand/collapse on click. No JavaScript framework — plain vanilla JS toggle.

**Getting Started**
- *How do I create a game?* — Go to the lobby, enter a game name, pick your system, click Create.
- *Do I need an account?* — No. You can play for up to 2 hours without signing up. After that, create a free account to keep your characters and your 10 free hours.
- *How do I invite friends?* — Share your game link. Anyone with the link can join and create a character.

**Characters**
- *How do I create a character?* — Go to the Character tab, fill in name, stats, personality, and backstory. Or upload a PDF character sheet and the AI will extract everything.
- *Can I upload a character sheet PDF?* — Yes. The AI reads it and fills in your stats, abilities, and backstory automatically.
- *How do I switch characters?* — Click "switch" in the turn banner at the top of the game screen.

**Gameplay**
- *What are action options?* — After each DM turn, you'll see 4 suggested actions. Click one, or type your own in the text box.
- *What does Skip do?* — Skips your turn and passes to the next player.
- *What does OOC mean?* — Out of Character. Send a message to other players that the DM ignores (for planning, jokes, etc.).
- *What does Catch Up do?* — If you joined late, this replays recent story events so you're up to speed.
- *What's the turn timer?* — The host can set a time limit per turn. When it expires, the AI acts for you.

**Game Settings (Host Tab)**
- *What's verbosity?* — Controls how long the DM's narration is. Terse (~20 words), Brief (~50), or Verbose (~100).
- *What's ferocity?* — Difficulty scale 1-5. Lower = harder encounters, more treasure. Higher = easier, gentler.
- *What are DM personas?* — Epic (dramatic, literary) or Over the Top (comedic, Critical Role energy).
- *What are pillars?* — The balance between Exploration, Combat, and Social encounters. Adjust sliders to taste.
- *What are rules corrections?* — House rules that override the AI's defaults. Add them in the Party tab and the AI follows them every turn.

**Maps & Images**
- *How does the auto-map work?* — The AI tracks locations as you explore and draws a map automatically. Three visual styles: Parchment, Dark, and Tactical.
- *When do scene images appear?* — At dramatic moments: entering new locations, meeting NPCs, combat encounters, and killshots.

**Discord**
- *How do I connect the Discord bot?* — Invite the TotMTable bot to your server, then use `/tt link <game-id>` in a channel.
- *What commands are available?* — `/tt action`, `/tt skip`, `/tt ooc`, `/tt status`, `/tt balance`, `/tt redeem`, and more. Type `/tt help` in Discord for the full list.

**Billing & Pricing**
- *How does the free tier work?* — You get 10 free hours when you create an account, then 5 free hours every month.
- *How do I buy more time?* — Click "Add Time" or go to the purchase page. Three options: 1hr ($1), 5hr ($4.50), 20hr ($15).
- *What happens when time runs out?* — You get warnings at 30, 10, and 1 minute. At zero, you enter spectator mode for 5 minutes (the AI plays for you). Then the game pauses until you add time.
- *What are promo codes?* — Beta testers may receive promo codes for free hours. Redeem at /redeem or use `/tt redeem <code>` in Discord.

## Visual Design

- Same CSS variables, fonts, and aesthetic as landing page and game
- Explainer sections: card-style with subtle gold borders, alternating layout
- FAQ accordion: dark parchment background, gold header text, chevron indicator for expand/collapse
- Smooth height transition on expand/collapse (CSS `max-height` transition)
- Mobile responsive: single column, full-width accordion items

## Implementation

- Single file: `public/help.html` (inline CSS/JS, matches all other pages)
- Add `GET /help` route in `server.js` (before `express.static`)
- Add "Help" link to landing page nav and lobby page
- No database changes, no server logic — purely static content
