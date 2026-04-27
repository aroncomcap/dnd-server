const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

async function test() {
  const direction = 'Small elite party - 2 characters. Fighter and Cleric. Level 1.';
  
  const directionBlock = `PLAYER DIRECTION: ${direction}\nFollow these instructions for party composition, level, and number of characters.\n\n`;
  
  const systemInstructions = `Create 4 D&D 5th Edition characters. For each:
- Choose a distinct race and class (ensure party balance: at least 1 melee, 1 healer/support, 1 ranged/caster, 1 versatile)
- Generate full ability scores (use standard array: 15,14,13,12,10,8 assigned appropriately for class)
- Calculate HP based on class hit die + CON modifier at the appropriate level
- List starting equipment appropriate to class and level
- Include spell lists for casters (prepared spells or known spells)
- Include any class features, subclass if level 3+
Use the level specified in the player direction above.`;

  const prompt = `${directionBlock}${systemInstructions}

For each character, output in this EXACT format (generate the number of characters specified in the direction, or 4 by default):

---CHARACTER---
NAME: [A fitting fantasy name]
STATS: [Full stat block as a single text block — include level, race, class, HP, ability scores, AC, speed, proficiencies, equipment, spells if any, class features]
COMBAT_JSON: {"level":N,"ac":N,"hp":N,"maxHp":N,"speed":30,"abilities":{"str":N,"dex":N,"con":N,"int":N,"wis":N,"cha":N},"proficiencyBonus":N,"saveProficiencies":["str","con"],"weapons":[{"name":"longsword","attackMod":"str","damage":"1d8","damageType":"slashing","properties":[]}],"spells":[],"spellSlots":{},"spellcastingAbility":null,"features":[]}
PERSONALITY: [2-3 sentences — personality traits, ideals, bonds, flaws]
ACTIONS: [Comma-separated standard actions: e.g., Attack with longsword, Cast Fireball, Dodge, Help ally]
BACKSTORY: [3-4 sentences — origin, motivation, how they joined the party]

IMPORTANT: COMBAT_JSON must be a single line of valid JSON with accurate numbers from the STATS block. Include ALL weapons and spells the character has. For spellcasters, include spellcastingAbility ("int"/"wis"/"cha"), spellSlots (e.g. {"1":4,"2":3,"3":2}), and spells with damage/healing info.

Generate the characters now.`;

  console.log('Sending prompt to Haiku...\n');
  
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    system: 'You are a character creation assistant for tabletop RPGs. Generate detailed, playable characters.',
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  console.log('Haiku Response:\n');
  console.log(text);
  console.log('\n\n--- PARSING ---\n');

  // Try to parse it
  const charBlocks = text.split('---CHARACTER---').filter(b => b.trim());
  console.log(`Found ${charBlocks.length} character blocks\n`);

  for (let i = 0; i < charBlocks.length; i++) {
    const block = charBlocks[i];
    const nameMatch = block.match(/NAME:\s*(.+)/i);
    console.log(`Block ${i+1}: nameMatch = ${nameMatch ? nameMatch[1] : 'NONE'}`);
  }
}

test().catch(console.error);
