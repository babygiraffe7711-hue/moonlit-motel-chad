// ===============================
// PART 1 — Imports, Setup, State, Utilities
// ===============================

const { Client, GatewayIntentBits, Partials, Events, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai').default;
const { DateTime } = require('luxon');

// Load brain.json (lore, dialogue, stages, ambient)
const brain = require('./brain.json');

// Paths for persistent storage
const STATE_PATH = path.join(__dirname, 'state.json');

// If state.json doesn't exist, create it
if (!fs.existsSync(STATE_PATH)) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({}, null, 2));
}

// Load state
let state = JSON.parse(fs.readFileSync(STATE_PATH));

// Save helper
function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Fetch guild-specific state block
function getGuildState(gid) {
  if (!state[gid]) {
    state[gid] = {
      stage: 1,
      gates: {},
      cooldowns: {},
      participants: {},
      prefs: { consents: {} },
      transcripts: {},
      jail: {
        lastId: 0,
        cases: {}
      }
    };
    saveState();
  }

  // Ensure jail structure exists
  if (!state[gid].jail) {
    state[gid].jail = {
      lastId: 0,
      cases: {}
    };
    saveState();
  }

  return state[gid];
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===============================
// CHANNEL + ROLE CONSTANTS
// ===============================
const CHANNELS = {
  court: "⚖️motel-court-of-weirdos🧑‍⚖️",
  lounge: "🎲the-lounge🎙️",
  jail_sfw: "🔒the-broom-closet🧹",
  jail_nsfw: "🤫the-no-tell-motel-room💣"
};

const ROLES = {
  jail_sfw: "SFW jail",
  jail_nsfw: "NSFW Jail"
};

// ===============================
// HELPER: Get channel by name
// ===============================
async function findChannel(guild, name) {
  return guild.channels.cache.find(ch => ch.name === name);
}

// ===============================
// HELPER: Get role by name
// ===============================
function findRole(guild, name) {
  return guild.roles.cache.find(role => role.name === name);
}

// ===============================
// END PART 1

// ===============================
// PART 2 — Slash Command Registration & Nominate Flow
// ===============================

// Define slash commands
const COMMANDS = [
  {
    name: 'nominate',
    description: 'Nominate someone for Motel Jail.',
    options: [
      {
        type: 6,
        name: 'user',
        description: 'Who are you sending to jail?',
        required: true
      },
      {
        type: 3,
        name: 'reason',
        description: 'What did they do?',
        required: true
      },
      {
        type: 3,
        name: 'justification',
        description: 'Why is this jail-worthy?',
        required: true
      }
    ]
  },
  {
    name: 'verdict',
    description: 'Deliver verdict based on votes.',
    default_member_permissions: PermissionsBitField.Flags.ManageGuild.toString(),
    options: [
      {
        type: 4,
        name: 'case',
        description: 'Case ID',
        required: true
      }
    ]
  },
  {
    name: 'choosejail',
    description: 'Choose your jail cell (SFW or NSFW).',
    options: [
      {
        type: 4,
        name: 'case',
        description: 'Case ID',
        required: true
      },
      {
        type: 3,
        name: 'cell',
        description: 'Which jail?',
        required: true,
        choices: [
          { name: 'SFW Jail', value: 'sfw' },
          { name: 'NSFW Jail', value: 'nsfw' }
        ]
      }
    ]
  },
  {
    name: 'sentence',
    description: 'Assign final punishment.',
    default_member_permissions: PermissionsBitField.Flags.ManageGuild.toString(),
    options: [
      {
        type: 4,
        name: 'case',
        description: 'Case ID',
        required: true
      },
      {
        type: 3,
        name: 'punishment',
        description: 'Final punishment text',
        required: true
      }
    ]
  },
  {
    name: 'release',
    description: 'Release a jailed user.',
    default_member_permissions: PermissionsBitField.Flags.ManageGuild.toString(),
    options: [
      {
        type: 4,
        name: 'case',
        description: 'Case ID',
        required: true
      }
    ]
  }
];

// Register commands once bot is ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await client.application.commands.set(COMMANDS);
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }
});

// ===============================
// NOMINATION FLOW — /nominate
// ===============================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const gState = getGuildState(interaction.guildId);

  // ------------------
  // /nominate
  // ------------------
  if (commandName === 'nominate') {
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    const justification = interaction.options.getString('justification', true);

    gState.jail.lastId += 1;
    const id = gState.jail.lastId;

    gState.jail.cases[id] = {
      id,
      guildId: interaction.guildId,
      nomineeId: target.id,
      nomineeTag: `${target.username}#${target.discriminator}`,
      nominatorId: interaction.user.id,
      reason,
      justification,
      status: 'voting',
      messageId: null,
      punishment: null,
      cell: null,
      timestamps: { nominatedAt: Date.now() }
    };

    saveState();

    const court = await findChannel(interaction.guild, CHANNELS.court);
    if (!court) {
      await interaction.reply({ content: `Court channel not found: ${CHANNELS.court}`, ephemeral: true });
      return;
    }

    const embed = {
      title: `🔒 Jail Nomination #${id}`,
      description:
        `**Nominee:** <@${target.id}>
**Nominator:** <@${interaction.user.id}>

**Crime:** ${reason}
**Justification:** ${justification}

Vote with ✅ or ❌!`,
      color: 0xffcc00,
      timestamp: new Date().toISOString()
    };

    const msg = await court.send({ embeds: [embed] });
    await msg.react('✅');
    await msg.react('❌');

    // Save nomination message ID for vote checking
    gState.jail.cases[id].messageId = msg.id;
    saveState();

    await interaction.reply({ content: `Nomination #${id} has been filed in the Court.`, ephemeral: true });
  }
});

// ===============================
// NEXT: PART 3

// ===============================
// PART 3 — VERDICT, JAIL CHOICE, SENTENCING, RELEASE
// ===============================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const guild = interaction.guild;
  const gState = getGuildState(guild.id);

  // ------------------
  // /verdict — MOD/SUNDAY decides when voting ends
  // ------------------
  if (commandName === 'verdict') {
    const caseId = interaction.options.getInteger('case', true);
    const record = gState.jail.cases[caseId];

    if (!record) {
      await interaction.reply({ content: `Case #${caseId} not found.`, ephemeral: true });
      return;
    }

    if (record.status !== 'voting') {
      await interaction.reply({ content: `Case #${caseId} is not in voting stage.`, ephemeral: true });
      return;
    }

    // Fetch nomination message
    const court = await findChannel(guild, CHANNELS.court);
    if (!court) {
      await interaction.reply({ content: `Court channel not found.`, ephemeral: true });
      return;
    }

    let nominationMsg = null;
    try {
      nominationMsg = await court.messages.fetch(record.messageId);
    } catch {
      await interaction.reply({ content: `Could not fetch original nomination message.`, ephemeral: true });
      return;
    }

    const reactions = nominationMsg.reactions.cache;
    const yes = reactions.get('✅')?.count || 0;
    const no = reactions.get('❌')?.count || 0;

    // Remove the bot's own reaction from count
    const yesVotes = yes > 0 ? yes - 1 : 0;
    const noVotes = no > 0 ? no - 1 : 0;

    let result = '';

    if (yesVotes > noVotes) {
      result = 'guilty';
      record.status = 'guilty';
      saveState();

      // Announce guilty in lounge
      const lounge = await findChannel(guild, CHANNELS.lounge);
      if (lounge) {
        await lounge.send(
          `🚨 **Verdict is in for Case #${caseId}!**
` +
          `<@${record.nomineeId}> has been **convicted** of:
> ${record.reason}

` +
          `Please proceed to ${CHANNELS.court} — they must now choose their jail cell before punishments are suggested.`
        );
      }

      // Announce in court
      await court.send(
        `⚖️ **Case #${caseId} — GUILTY**
` +
        `**Crime:** ${record.reason}
` +
        `**Justification:** ${record.justification}

` +
        `<@${record.nomineeId}>, you must now choose your jail cell:
` +
        `Run: \`/choosejail case:${caseId} cell:sfw\` OR \`/choosejail case:${caseId} cell:nsfw\``
      );

      await interaction.reply({ content: `Verdict recorded: GUILTY`, ephemeral: true });

    } else {
      result = 'innocent';
      record.status = 'innocent';
      saveState();

      // Announce innocence
      const lounge = await findChannel(guild, CHANNELS.lounge);
      if (lounge) {
        await lounge.send(`🕊️ **Case #${caseId}: <@${record.nomineeId}> has been found NOT GUILTY.** The Motel Court has spoken.`);
      }

      await court.send(`⚖️ **Case #${caseId} — NOT GUILTY**. They may return to the chaos.`);
      await interaction.reply({ content: `Verdict recorded: NOT GUILTY`, ephemeral: true });
    }
  }

  // ------------------
  // /choosejail — user picks SFW or NSFW
  // ------------------
  if (commandName === 'choosejail') {
    const caseId = interaction.options.getInteger('case', true);
    const cell = interaction.options.getString('cell', true);
    const record = gState.jail.cases[caseId];

    if (!record) {
      await interaction.reply({ content: `Case #${caseId} not found.`, ephemeral: true });
      return;
    }

    if (record.nomineeId !== interaction.user.id) {
      await interaction.reply({ content: `Only the jailed user can choose their jail.`, ephemeral: true });
      return;
    }

    if (record.status !== 'guilty') {
      await interaction.reply({ content: `Case #${caseId} is not awaiting jail selection.`, ephemeral: true });
      return;
    }

    let roleName = cell === 'sfw' ? ROLES.jail_sfw : ROLES.jail_nsfw;
    const role = findRole(guild, roleName);

    if (!role) {
      await interaction.reply({ content: `Role not found: ${roleName}`, ephemeral: true });
      return;
    }

    const member = await guild.members.fetch(record.nomineeId);
    await member.roles.add(role);

    record.cell = cell;
    record.status = 'jailed';
    record.timestamps.jailedAt = Date.now();
    saveState();

    const court = await findChannel(guild, CHANNELS.court);
    const lounge = await findChannel(guild, CHANNELS.lounge);

    if (court) {
      await court.send(
        `🚪 **Case #${caseId}: <@${record.nomineeId}> has chosen the ${cell === 'sfw' ? 'SFW Jail' : 'NSFW Jail'}.**
` +
        `Punishment suggestions may now begin!`
      );
    }

    if (lounge) {
      await lounge.send(
        `🔒 <@${record.nomineeId}> has entered the **${cell === 'sfw' ? 'SFW Jail' : 'NSFW Jail'}** for Case #${caseId}.
` +
        `Head to ${CHANNELS.court} to suggest their punishment.`
      );
    }

    await interaction.reply({ content: `Jail cell chosen.`, ephemeral: true });
  }

  // ------------------
  // /sentence — assign final punishment
  // ------------------
  if (commandName === 'sentence') {
    const caseId = interaction.options.getInteger('case', true);
    const punishment = interaction.options.getString('punishment', true);
    const record = gState.jail.cases[caseId];

    if (!record) {
      await interaction.reply({ content: `Case #${caseId} not found.`, ephemeral: true });
      return;
    }

    if (record.status !== 'jailed') {
      await interaction.reply({ content: `Case #${caseId} is not in sentencing stage.`, ephemeral: true });
      return;
    }

    record.punishment = punishment;
    record.status = 'awaiting_punishment';
    record.timestamps.sentencedAt = Date.now();
    saveState();

    const court = await findChannel(guild, CHANNELS.court);
    const lounge = await findChannel(guild, CHANNELS.lounge);

    if (court) {
      await court.send(
        `🧾 **Sentence for Case #${caseId}:**
` +
        `<@${record.nomineeId}> must:
> ${punishment}`
      );
    }

    if (lounge) {
      await lounge.send(
        `🔨 **Punishment Assigned — Case #${caseId}**
` +
        `<@${record.nomineeId}> has received their sentence. The Motel Court will release them once they complete it.`
      );
    }

    await interaction.reply({ content: `Punishment recorded.`, ephemeral: true });
  }

  // ------------------
  // /release — final step
  // ------------------
  if (commandName === 'release') {
    const caseId = interaction.options.getInteger('case', true);
    const record = gState.jail.cases[caseId];

    if (!record) {
      await interaction.reply({ content: `Case #${caseId} not found.`, ephemeral: true });
      return;
    }

    if (record.status !== 'awaiting_punishment') {
      await interaction.reply({ content: `Case #${caseId} is not ready for release.`, ephemeral: true });
      return;
    }

    // Remove role
    const cell = record.cell;
    const roleName = cell === 'sfw' ? ROLES.jail_sfw : ROLES.jail_nsfw;
    const role = findRole(guild, roleName);
    if (role) {
      const member = await guild.members.fetch(record.nomineeId);
      await member.roles.remove(role);
    }

    record.status = 'released';
    record.timestamps.releasedAt = Date.now();
    saveState();

    const court = await findChannel(guild, CHANNELS.court);
    const lounge = await findChannel(guild, CHANNELS.lounge);

    if (court) {
      await court.send(`🕊️ **Case #${caseId} is now CLOSED. <@${record.nomineeId}> has been released.**`);
    }

    if (lounge) {
      await lounge.send(`🕊️ <@${record.nomineeId}> has completed their sentence for Case #${caseId} and has been **released**.`);
    }

    await interaction.reply({ content: `User released.`, eph

// ===============================
// PART 4 — EXISTING CHAD FEATURES (Lore, AI Replies, Ambient, Summaries)
// ===============================

// --- TRANSCRIPT TRACKING ---
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  const gState = getGuildState(msg.guild.id);

  if (!gState.transcripts[msg.channel.id]) gState.transcripts[msg.channel.id] = [];

  gState.transcripts[msg.channel.id].push({
    user: msg.author.id,
    content: msg.content,
    ts: Date.now()
  });

  if (gState.transcripts[msg.channel.id].length > 200) gState.transcripts[msg.channel.id].shift();
  saveState();
});

// --- SUMMARIZER COMMAND ---
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const content = msg.content.toLowerCase();
  if (!content.startsWith("chad, summarize")) return;

  const gState = getGuildState(msg.guild.id);
  const transcript = gState.transcripts[msg.channel.id] || [];

  if (transcript.length === 0) {
    msg.reply("Nothing to summarize, babe.");
    return;
  }

  const formatted = transcript.map(t => `<@${t.user}>: ${t.content}`).join("
");

  const summary = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Summarize the conversation." },
      { role: "user", content: formatted }
    ]
  });

  msg.reply(summary.choices[0].message.content);
});

// --- PERSONALITY WEIGHTING ---
function weightedTone() {
  const roll = Math.random();
  if (roll < 0.3) return "snark";
  if (roll < 0.5) return "haunt";
  return "normal";
}

function toneLine(type) {
  if (type === "snark") return brain.petty[Math.floor(Math.random() * brain.petty.length)];
  if (type === "haunt") return brain.ambient[Math.floor(Math.random() * brain.ambient.length)];
  return brain.normal[Math.floor(Math.random() * brain.normal.length)] || "Ok then.";
}

// --- FALLBACK AI MESSAGE HANDLER ---
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const lowered = msg.content.toLowerCase();

  if (!lowered.startsWith("chad")) return;

  const tone = weightedTone();
  const vibe = toneLine(tone);

  const reply = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are Chad the Motel AI. Sarcastic, weird, spooky, helpful." },
      { role: "user", content: msg.content },
      { role: "assistant", content: vibe }
    ]
  });

  msg.reply(reply.choices[0].message.content);
});

// --- AMBIENT HAUNTINGS EVERY 3 HOURS ---
setInterval(async () => {
  const text = brain.ambient[Math.floor(Math.random() * brain.ambient.length)];

  client.guilds.cache.forEach(async (guild) => {
    const lounge = guild.channels.cache.find(ch => ch.name === CHANNELS.lounge);
    if (lounge) lounge.send(`🕯️ ${text}`);
  });
}, 3 * 60 * 60 * 1000);

// ===============================
// PART 5 — LOGIN
// ===============================
client.login(process.env.DISCORD_TOKEN);

