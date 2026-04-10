const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('./db');

let gameEngine = null; // set by server.js

function setGameEngine(engine) {
  gameEngine = engine;
}

// ── Discord user → character bindings (per game) ─────────────────────────────
async function bindUser(gameId, discordUserId, charName) {
  const bindings = await db.getState(gameId, 'discord_bindings', {});
  bindings[discordUserId] = charName;
  await db.setState(gameId, 'discord_bindings', bindings);
}

async function getCharName(gameId, discordUserId) {
  const bindings = await db.getState(gameId, 'discord_bindings', {});
  return bindings[discordUserId] || null;
}

// ── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Slash Commands ───────────────────────────────────────────────────────────
function buildSubcommands(builder) {
  return builder
    .addSubcommand(sub => sub
      .setName('join')
      .setDescription('Link this channel to a game')
      .addStringOption(opt => opt.setName('game').setDescription('Game ID (from the URL)').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub
      .setName('games')
      .setDescription('List available games'))
    .addSubcommand(sub => sub
      .setName('register')
      .setDescription('Register a character'))
    .addSubcommand(sub => sub
      .setName('action')
      .setDescription('Take an action on your turn')
      .addStringOption(opt => opt.setName('text').setDescription('What does your character do?').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('start')
      .setDescription('Begin the adventure (host only)')
      .addStringOption(opt => opt.setName('prompt').setDescription('Opening scene prompt (optional)')))
    .addSubcommand(sub => sub
      .setName('party')
      .setDescription('Show party members'))
    .addSubcommand(sub => sub
      .setName('skip')
      .setDescription('Skip the current player\'s turn'))
    .addSubcommand(sub => sub
      .setName('timer')
      .setDescription('Set turn timer (seconds)')
      .addIntegerOption(opt => opt.setName('seconds').setDescription('Seconds per turn (10-3600)').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('claim')
      .setDescription('Claim an existing character')
      .addStringOption(opt => opt.setName('name').setDescription('Character name to play as').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub
      .setName('catchup')
      .setDescription('Summarize what happened since your last turn'))
    .addSubcommand(sub => sub
      .setName('world')
      .setDescription('Show known locations and NPCs'))
    .addSubcommand(sub => sub
      .setName('reset')
      .setDescription('Reset the game (keeps characters)'));
}

const commands = [
  buildSubcommands(new SlashCommandBuilder().setName('tavern').setDescription('Tavern Table game commands')),
  buildSubcommands(new SlashCommandBuilder().setName('tt').setDescription('Tavern Table (shortcut)')),
];

async function registerCommands() {
  if (!process.env.DISCORD_BOT_TOKEN) return;
  const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('Discord slash commands registered');
  } catch (err) {
    console.error('Failed to register Discord commands:', err.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function stripMarkdown(text) {
  // Keep ** for Discord bold, strip ---OPTIONS--- and ---SCENE--- blocks
  const optIdx = text.indexOf('---OPTIONS---');
  const sceneIdx = text.indexOf('---SCENE---');
  let end = text.length;
  if (optIdx !== -1) end = Math.min(end, optIdx);
  if (sceneIdx !== -1) end = Math.min(end, sceneIdx);
  return text.slice(0, end).trim();
}

function makeNarrationEmbed(text, isAuto = false, autoPlayer = null) {
  const embed = new EmbedBuilder()
    .setColor(0xC8922A)
    .setDescription(text.slice(0, 4096));
  if (isAuto) {
    embed.setAuthor({ name: `🤖 Auto-action for ${autoPlayer}` });
  } else {
    embed.setAuthor({ name: '🎲 Game Master' });
  }
  return embed;
}

function makeOptionButtons(options) {
  if (!options || !options.length) return [];
  const rows = [];
  // Discord max 5 buttons per row, max 5 rows
  for (let i = 0; i < options.length && i < 4; i++) {
    const label = options[i].slice(0, 80); // Discord button label max 80 chars
    rows.push(
      new ButtonBuilder()
        .setCustomId(`action_${i}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return [new ActionRowBuilder().addComponents(...rows)];
}

function makeTurnEmbed(playerName, token, durationMs) {
  const seconds = Math.round((durationMs || 180000) / 1000);
  const expiresAt = Math.floor((Date.now() + (durationMs || 180000)) / 1000);
  const embed = new EmbedBuilder()
    .setColor(0xF0C060)
    .setTitle(`⚔️ ${playerName}'s Turn`)
    .setDescription(`Choose an action above, type in the channel, or use \`/tt action\`.\n\n⏱️ Timer: **${seconds}s** — expires <t:${expiresAt}:R>`)
    .setFooter({ text: 'Claude acts for you if time runs out' });
  if (token && token.startsWith('http')) {
    embed.setThumbnail(token);
  }
  return embed;
}

// ── Interaction Handler ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  // Handle autocomplete
  if (interaction.isAutocomplete()) {
    const sub = interaction.options.getSubcommand();
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'game') {
      const gamesList = await db.listGames();
      const filtered = gamesList
        .filter(g => g.id.includes(focused.value.toLowerCase()) || g.name.toLowerCase().includes(focused.value.toLowerCase()))
        .slice(0, 25);
      await interaction.respond(
        filtered.map(g => ({ name: `${g.name} (${g.system})`, value: g.id }))
      );
      return;
    }

    if (focused.name === 'name') {
      const gameId = await db.getChannelGame(interaction.channelId);
      if (!gameId) {
        await interaction.respond([]);
        return;
      }
      const gs = gameEngine.getGameState(gameId);
      const chars = Object.keys(gs.data.characters);
      const filtered = chars
        .filter(n => n.toLowerCase().includes(focused.value.toLowerCase()))
        .slice(0, 25);
      await interaction.respond(
        filtered.map(n => ({ name: n, value: n }))
      );
      return;
    }

    await interaction.respond([]);
    return;
  }

  // Handle button clicks (action options)
  if (interaction.isButton() && interaction.customId.startsWith('action_')) {
    const idx = parseInt(interaction.customId.split('_')[1]);
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'This channel is not linked to a game.', ephemeral: true });
      return;
    }
    // Get the button label as the action text
    const actionText = interaction.message.components[0]?.components[idx]?.label;
    if (!actionText) {
      await interaction.reply({ content: 'Invalid action.', ephemeral: true });
      return;
    }
    const charName = await getCharName(gameId, interaction.user.id);
    if (!charName) {
      await interaction.reply({ content: 'You haven\'t registered a character yet. Use `/tavern register` first.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const result = await gameEngine.playerAction(gameId, charName, actionText);
      if (result.error) {
        await interaction.editReply(result.error);
      } else {
        await interaction.editReply(`**${charName}:** ${actionText}`);
      }
    } catch (err) {
      await interaction.editReply('Error processing action.');
    }
    return;
  }

  // Handle modal submissions (character registration)
  if (interaction.isModalSubmit() && interaction.customId === 'register_modal') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel to a game first with `/tavern join`.', ephemeral: true });
      return;
    }
    const name = interaction.fields.getTextInputValue('char_name');
    const statsText = interaction.fields.getTextInputValue('char_stats');
    const personality = interaction.fields.getTextInputValue('char_personality');
    const actions = interaction.fields.getTextInputValue('char_actions');
    const backstory = interaction.fields.getTextInputValue('char_backstory');

    await interaction.deferReply();
    try {
      await gameEngine.registerCharacter(gameId, name, {
        statsText, personality, standardActions: actions, backstory,
      });
      await bindUser(gameId, interaction.user.id, name);
      await interaction.editReply(`📜 **${name}** has joined the campaign! You're now bound to this character.`);
    } catch (err) {
      await interaction.editReply('Error registering character.');
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'tavern' && interaction.commandName !== 'tt') return;

  const sub = interaction.options.getSubcommand();

  // ── /tavern join ───────────────────────────────────────────
  if (sub === 'join') {
    const gameId = interaction.options.getString('game');
    const game = await db.getGame(gameId);
    if (!game) {
      await interaction.reply({ content: `Game "${gameId}" not found. Check the URL slug.`, ephemeral: true });
      return;
    }
    await db.linkChannel(interaction.channelId, interaction.guildId, gameId);
    const embed = new EmbedBuilder()
      .setColor(0xC8922A)
      .setTitle(`⚔️ Linked to: ${game.name}`)
      .setDescription(`This channel is now connected to **${game.name}** (${game.system}).\n\nUse \`/tavern register\` to create a character, then \`/tavern start\` to begin!`)
      .setFooter({ text: `Game ID: ${gameId}` });
    await interaction.reply({ embeds: [embed] });
  }

  // ── /tavern games ──────────────────────────────────────────
  else if (sub === 'games') {
    const gamesList = await db.listGames();
    if (!gamesList.length) {
      await interaction.reply({ content: 'No games created yet. Create one at the web UI.', ephemeral: true });
      return;
    }
    const desc = gamesList.map(g => `**${g.name}** — \`${g.id}\` (${g.system})`).join('\n');
    const embed = new EmbedBuilder()
      .setColor(0xC8922A)
      .setTitle('🏰 Available Games')
      .setDescription(desc)
      .setFooter({ text: 'Use /tavern join <game-id> to link this channel' });
    await interaction.reply({ embeds: [embed] });
  }

  // ── /tavern register ───────────────────────────────────────
  else if (sub === 'register') {
    const modal = new ModalBuilder()
      .setCustomId('register_modal')
      .setTitle('Register Character');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('char_name').setLabel('Character Name')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Aragorn')),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('char_stats').setLabel('Character Stats (any format)')
          .setStyle(TextInputStyle.Paragraph).setRequired(false)
          .setPlaceholder('Level 5 Human Ranger, HP 42, STR 16 DEX 14...')),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('char_personality').setLabel('Personality & Traits')
          .setStyle(TextInputStyle.Short).setRequired(false)
          .setPlaceholder('Bold, protective, distrusts magic')),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('char_actions').setLabel('Standard Actions (comma-separated)')
          .setStyle(TextInputStyle.Short).setRequired(false)
          .setPlaceholder('Attack, Dodge, Cast Fireball')),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('char_backstory').setLabel('Backstory (brief)')
          .setStyle(TextInputStyle.Paragraph).setRequired(false)
          .setPlaceholder('Raised in the north, exiled knight...')),
    );

    await interaction.showModal(modal);
  }

  // ── /tavern action ─────────────────────────────────────────
  else if (sub === 'action') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first with `/tavern join`.', ephemeral: true });
      return;
    }
    const text = interaction.options.getString('text');
    const charName = await getCharName(gameId, interaction.user.id);
    if (!charName) {
      await interaction.reply({ content: 'You haven\'t registered a character yet. Use `/tavern register` first.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const result = await gameEngine.playerAction(gameId, charName, text);
      if (result.error) {
        await interaction.editReply(result.error);
      } else {
        await interaction.editReply(`**${charName}:** ${text}`);
      }
    } catch (err) {
      await interaction.editReply('Error processing action.');
    }
  }

  // ── /tavern start ──────────────────────────────────────────
  else if (sub === 'start') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first with `/tavern join`.', ephemeral: true });
      return;
    }
    const prompt = interaction.options.getString('prompt');
    await interaction.deferReply();
    try {
      await gameEngine.startGame(gameId, prompt);
      await interaction.editReply('⚔️ The adventure begins...');
    } catch (err) {
      await interaction.editReply('Failed to start the game.');
    }
  }

  // ── /tavern party ──────────────────────────────────────────
  else if (sub === 'party') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first with `/tavern join`.', ephemeral: true });
      return;
    }
    const gs = gameEngine.getGameState(gameId);
    const chars = gs.data.characters;
    if (!Object.keys(chars).length) {
      await interaction.reply({ content: 'No adventurers registered yet.', ephemeral: true });
      return;
    }
    const desc = Object.entries(chars).map(([name, c]) => {
      return `**${name}**\n${c.statsText || 'No stats'}\n*${c.personality || 'No personality set'}*`;
    }).join('\n\n');
    const embed = new EmbedBuilder()
      .setColor(0xC8922A)
      .setTitle('🛡 Party Members')
      .setDescription(desc.slice(0, 4096));
    await interaction.reply({ embeds: [embed] });
  }

  // ── /tavern reset ──────────────────────────────────────────
  else if (sub === 'skip') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first.', ephemeral: true });
      return;
    }
    await gameEngine.skipTurn(gameId);
    await interaction.reply('⏭️ Turn skipped.');
  }

  else if (sub === 'timer') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first.', ephemeral: true });
      return;
    }
    const seconds = interaction.options.getInteger('seconds');
    const result = gameEngine.setTimer(gameId, seconds);
    await interaction.reply(`⏱️ Turn timer set to **${result.duration} seconds**.`);
  }

  else if (sub === 'claim') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first.', ephemeral: true });
      return;
    }
    const name = interaction.options.getString('name');
    const gs = gameEngine.getGameState(gameId);
    if (!gs.data.characters[name]) {
      const available = Object.keys(gs.data.characters);
      const list = available.length ? available.map(n => `\`${n}\``).join(', ') : 'none';
      await interaction.reply({ content: `Character "${name}" not found. Available: ${list}`, ephemeral: true });
      return;
    }
    await bindUser(gameId, interaction.user.id, name);
    const char = gs.data.characters[name];
    const embed = new EmbedBuilder()
      .setColor(0xC8922A)
      .setTitle(`🎭 Now playing as ${name}`)
      .setDescription(char.statsText || 'No stats');
    if (char.token) embed.setThumbnail(char.token);
    await interaction.reply({ embeds: [embed] });
  }

  else if (sub === 'catchup') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first.', ephemeral: true });
      return;
    }
    const charName = await getCharName(gameId, interaction.user.id);
    if (!charName) {
      await interaction.reply({ content: 'Claim a character first with `/tt claim <name>`.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await gameEngine.catchUp(gameId, charName);
      const embed = new EmbedBuilder()
        .setColor(0xC8922A)
        .setTitle(`📜 Catch-Up for ${charName}`)
        .setDescription(result.summary.slice(0, 4096));
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply('Error generating catch-up summary.');
    }
  }

  else if (sub === 'world') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first.', ephemeral: true });
      return;
    }
    const world = await db.getState(gameId, 'world', { locations: [], npcs: [] });
    const locText = world.locations?.length
      ? world.locations.map(l => `**${l.name}** — ${l.description}${l.distance ? ` *(${l.distance})*` : ''}`).join('\n')
      : '*No locations discovered yet.*';
    const npcText = world.npcs?.length
      ? world.npcs.map(n => `**${n.name}** — ${n.description}${n.location ? ` *(${n.location})*` : ''}`).join('\n')
      : '*No NPCs encountered yet.*';
    const accText = world.accomplishments?.length
      ? world.accomplishments.map(a => `**${a.character}** — ${a.achievement}`).join('\n')
      : '*No accomplishments yet.*';
    const embed = new EmbedBuilder()
      .setColor(0xC8922A)
      .setTitle('🗺️ Known World')
      .addFields(
        { name: '📍 Locations', value: locText.slice(0, 1024) },
        { name: '👤 NPCs', value: npcText.slice(0, 1024) },
        { name: '🏆 Accomplishments', value: accText.slice(0, 1024) }
      );
    await interaction.reply({ embeds: [embed] });
  }

  else if (sub === 'reset') {
    const gameId = await db.getChannelGame(interaction.channelId);
    if (!gameId) {
      await interaction.reply({ content: 'Link this channel first.', ephemeral: true });
      return;
    }
    await gameEngine.resetGame(gameId);
    await interaction.reply('🔄 Game has been reset. Characters preserved.');
  }
});

// ── Plain message handler (just type your action) ────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const gameId = await db.getChannelGame(message.channelId);
  if (!gameId) return;

  const charName = await getCharName(gameId, message.author.id);
  if (!charName) return; // Not registered — ignore

  const text = message.content.trim();
  if (!text || text.startsWith('/')) return; // Ignore empty or commands

  try {
    const result = await gameEngine.playerAction(gameId, charName, text);
    if (result.error) {
      await message.reply({ content: result.error, allowedMentions: { repliedUser: false } });
    }
    // Success — DM response broadcasts automatically
  } catch (err) {
    // Silently fail — might not be their turn
  }
});

// ── Broadcast game events to Discord channels ───────────────────────────────
async function broadcastToChannels(gameId, fn) {
  const channels = await db.getGameChannels(gameId);
  for (const channelId of channels) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel) await fn(channel);
    } catch (err) {
      // Channel might be deleted or bot removed
      console.error(`Failed to send to channel ${channelId}:`, err.message);
    }
  }
}

async function onDmMessage(gameId, data) {
  await broadcastToChannels(gameId, async (channel) => {
    const embed = makeNarrationEmbed(
      stripMarkdown(data.text),
      data.auto || false,
      data.player
    );
    const components = makeOptionButtons(data.options);
    await channel.send({ embeds: [embed], components });
  });
}

async function onTurnChange(gameId, data) {
  await broadcastToChannels(gameId, async (channel) => {
    const embed = makeTurnEmbed(data.player, data.token, data.duration);
    await channel.send({ embeds: [embed] });
  });
}

async function onSystem(gameId, data) {
  await broadcastToChannels(gameId, async (channel) => {
    await channel.send(`*${data.text}*`);
  });
}

async function onSceneImage(gameId, data) {
  if (!data.url) return;
  await broadcastToChannels(gameId, async (channel) => {
    // base64 data URLs need to be sent as attachments
    if (data.url.startsWith('data:')) {
      const base64 = data.url.split(',')[1];
      const buffer = Buffer.from(base64, 'base64');
      await channel.send({ files: [{ attachment: buffer, name: 'scene.png' }] });
    } else {
      await channel.send(data.url);
    }
  });
}

async function onCharacterToken(gameId, data) {
  // Token generated notification
  await broadcastToChannels(gameId, async (channel) => {
    if (data.token && data.token.startsWith('data:')) {
      const base64 = data.token.split(',')[1];
      const buffer = Buffer.from(base64, 'base64');
      await channel.send({
        content: `🎨 Token generated for **${data.name}**`,
        files: [{ attachment: buffer, name: `${data.name}-token.png` }],
      });
    }
  });
}

// ── Start ────────────────────────────────────────────────────────────────────
async function startBot() {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.log('No DISCORD_BOT_TOKEN — Discord bot disabled');
    return;
  }
  client.once('ready', async () => {
    console.log(`Discord bot logged in as ${client.user.tag}`);
    await registerCommands();
  });
  await client.login(process.env.DISCORD_BOT_TOKEN);
}

module.exports = {
  startBot,
  setGameEngine,
  onDmMessage,
  onTurnChange,
  onSystem,
  onSceneImage,
  onCharacterToken,
};
