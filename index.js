// ===============================
// CHAD 2.0 — CLEAN REBUILD
// Node.js (CommonJS) — Guild Only
// Server ID: 1432692253897265244
// ===============================

// PART 1 — Imports, Setup, Client, State
// ===============================

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionsBitField
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// Load brain.json personality & lore
const brain = require('./brain.json');

// State file path
const STATE_PATH = path.join(__dirname, 'state.json');

if (!fs.existsSync(STATE_PATH)) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({}, null, 2));
}

let state = JSON.parse(fs.readFileSync(STATE_PATH));
function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Per-guild persistent memory
function getGuildState(gid) {
  if (!state[gid]) {
    state[gid] = {
      jail: { lastId: 0, cases: {} },
      transcripts: {},
      prefs: {},
      records: {} // criminal records per user
    };
    saveState();
  }
  if (!state[gid].records) {
    state[gid].records = {};
  }
  return state[gid];
}

// Discord client
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

// Channels & Roles
const CHANNELS = {
  court: '⚖️motel-court-of-weirdos🧑‍⚖️',
  lounge: '🎲the-lounge🎙️',
  jail_sfw: '🔒the-broom-closet🧹',
  jail_nsfw: '🤫the-no-tell-motel-room💣'
};

const ROLES = {
  jail_sfw: 'SFW jail',
  jail_nsfw: 'NSFW Jail'
};

// Helpers
async function findChannel(guild, name) {
  return guild.channels.cache.find(ch => ch.name === name);
}

function findRole(guild, name) {
  return guild.roles.cache.find(role => role.name === name);
}

function getRecord(gState, userId) {
  if (!gState.records) gState.records = {};
  if (!gState.records[userId]) {
    gState.records[userId] = {
      totalCharges: 0,
      totalGuilty: 0,
      totalNotGuilty: 0,
      totalReleases: 0,
      cases: []
    };
  }
  return gState.records[userId];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatCourtLine(template, data) {
  return template
    .replace(/\{case\}/g, data.case)
    .replace(/\{user\}/g, data.user)
    .replace(/\{cell\}/g, data.cell || '');
}

// Court flavor lines
const COURT_GUILTY_LINES = [
  '⚖️ **Case #{case} — GUILTY.** The neon hums disapprovingly at {user}.',
  '⚖️ **Case #{case}:** The jury of weirdos has spoken. {user} is **GUILTY**.',
  '⚖️ **Verdict — GUILTY (Case #{case}).** {user}, even the ice machine is judging you.'
];

const COURT_INNOCENT_LINES = [
  '⚖️ **Case #{case} — NOT GUILTY.** The Motel begrudgingly lets {user} walk.',
  '⚖️ **Case #{case}: ACQUITTED.** {user} slips through the cracks this time.',
  '⚖️ **Case #{case} — FREE.** The Court of Weirdos shrugs and releases {user}.'
];

const COURT_JAIL_LINES = [
  '🚪 **Case #{case}:** {user} is dragged into the {cell}. The door clicks shut.',
  '🚪 **Case #{case}:** {user} steps into the {cell} like they own the place. They do not.',
  '🚪 **Case #{case}:** {user} chose the {cell}. Bold of them to think they had a choice.'
];

const COURT_SENTENCE_LINES = [
  '🧾 **Sentence for Case #{case}:** The Motel demands tribute from {user}.',
  '🧾 **Case #{case} Sentencing:** {user} now owes the Motel a favor.',
  '🧾 **Judgment for Case #{case}:** {user} has a little quest now.'
];

const COURT_RELEASE_LINES = [
  '🕊️ **Case #{case} closed.** {user} is released back into the Motel ecosystem.',
  '🕊️ **Case #{case}:** {user} slips out of jail, slightly haunted but technically free.',
  '🕊️ **Release — Case #{case}.** {user} is loosed upon the halls once more.'
];

// ===============================
// PART 1 COMPLETE — READY FOR PART 2
// ===============================



// PART 2 — Slash Commands (Guild Only) + /nominate
// ===============================

const COMMANDS = [
  {
    name: 'nominate',
    description: 'Nominate someone for Motel Jail.',
    options: [
      {
        type: 6,
        name: 'user',
        description: 'Who are you accusing?',
        required: true
      },
      {
        type: 3,
        name: 'reason',
        description: 'What crime did they commit (funny, not serious)?',
        required: true
      },
      {
        type: 3,
        name: 'justification',
        description: 'Why do you believe this warrants jail?',
        required: true
      }
    ]
  },
  {
    name: 'verdict',
    description: 'Mods/Sunday: evaluate votes & deliver verdict.',
    default_member_permissions: PermissionsBitField.Flags.ManageGuild.toString(),
    options: [
      {
        type: 4,
        name: 'case',
        description: 'Case ID to judge.',
        required: true
      }
    ]
  },
  {
    name: 'choosejail',
    description: 'Choose SFW or NSFW jail (for convicted user).',
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
        description: 'Which jail do you accept?',
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
    description: 'Assign the final punishment (mods only).',
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
        description: 'Punishment text',
        required: true
      }
    ]
  },
  {
    name: 'release',
    description: 'Release a jailed user (mods only).',
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
    name: 'record',
    description: "View a guest's Motel criminal record.",
    options: [
      {
        type: 6,
        name: 'user',
        description: 'Whose record do you want to see?',
        required: true
      }
    ]
  },
  {
    name: 'casearticle',
    description: 'Have Chad write a motel newspaper article about a case.',
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

// Register slash commands on ready (guild-only for instant load)
// FUTURE-PROOF: use Events.ClientReady instead of "ready"
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  try {
    const guild = await c.guilds.fetch('1432692253897265244');
    await guild.commands.set(COMMANDS);
    console.log('Guild-only slash commands registered.');
  } catch (err) {
    console.error('Slash command registration failed:', err);
  }
});

// ===============================
// /nominate implementation (with Lounge announcement)
// ===============================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const guild = interaction.guild;
  const gState = getGuildState(guild.id);

  if (commandName === 'nominate') {
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    const justification = interaction.options.getString('justification', true);

    gState.jail.lastId += 1;
    const id = gState.jail.lastId;

    gState.jail.cases[id] = {
      id,
      guildId: guild.id,
      nomineeId: target.id,
      nominatorId: interaction.user.id,
      reason,
      justification,
      status: 'voting',
      messageId: null,
      punishment: null,
      cell: null,
      timestamps: { nominatedAt: Date.now() }
    };

    const rec = getRecord(gState, target.id);
    rec.totalCharges += 1;
    rec.cases.push(id);
    saveState();

    const court = await findChannel(guild, CHANNELS.court);
    if (!court) {
      return interaction.reply({ content: `Court channel not found: ${CHANNELS.court}`, flags: 64 });
    }

    const embed = {
      title: `🔒 Jail Nomination #${id}`,
      description:
        `**Accused:** <@${target.id}>\n` +
        `**Accuser:** <@${interaction.user.id}>\n\n` +
        `**Crime:** ${reason}\n` +
        `**Justification:** ${justification}\n\n` +
        `Vote using ✅ or ❌`,
      color: 0xffcc00,
      timestamp: new Date().toISOString()
    };

    const msg = await court.send({ embeds: [embed] });
    await msg.react('✅');
    await msg.react('❌');

    // Announce in the Lounge (no tagging the accused here)
    const lounge = await findChannel(guild, CHANNELS.lounge);
    if (lounge) {
      const accusedName =
        guild.members.cache.get(target.id)?.user.username ||
        target.username ||
        'a mysterious guest';

      lounge.send(
        `🔔 **A new case has been filed in the Motel Court!**\n` +
        `Case #${id}: **${accusedName}** stands accused.\n` +
        `Head to the court to cast your vote — justice needs your chaos.`
      );
    }

    gState.jail.cases[id].messageId = msg.id;
    saveState();

    await interaction.reply({ content: `Nomination #${id} filed in the court.`, flags: 64 });
  }
});

// ===============================
// PART 3 — VERDICT, CHOOSEJAIL, SENTENCE, RELEASE, RECORD, CASEARTICLE
// ===============================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const guild = interaction.guild;
  const gState = getGuildState(guild.id);

  // /verdict
  if (commandName === 'verdict') {
    const caseId = interaction.options.getInteger('case', true);
    const record = gState.jail.cases[caseId];

    if (!record) return interaction.reply({ content: `Case #${caseId} not found.`, flags: 64 });
    if (record.status !== 'voting') {
      return interaction.reply({ content: `Case #${caseId} is not in voting stage.`, flags: 64 });
    }

    const court = await findChannel(guild, CHANNELS.court);
    if (!court) return interaction.reply({ content: 'Court channel not found.', flags: 64 });

    let nominationMsg;
    try {
      nominationMsg = await court.messages.fetch(record.messageId);
    } catch {
      return interaction.reply({ content: 'Could not fetch original nomination message.', flags: 64 });
    }

    const reactions = nominationMsg.reactions.cache;
    const yes = reactions.get('✅')?.count || 0;
    const no = reactions.get('❌')?.count || 0;

    const yesVotes = Math.max(yes - 1, 0);
    const noVotes = Math.max(no - 1, 0);

    const lounge = await findChannel(guild, CHANNELS.lounge);
    const accusedTag = `<@${record.nomineeId}>`;
    const accusedName = guild.members.cache.get(record.nomineeId)?.user.username || 'the accused';

    if (yesVotes > noVotes) {
      record.status = 'guilty';
      const rec = getRecord(gState, record.nomineeId);
      rec.totalGuilty += 1;
      saveState();

      if (lounge) {
        await lounge.send(
          '🚨 Verdict for Case #' + caseId + ': GUILTY.\n' +
          accusedName + ' has been convicted.\n' +
          'Proceed to the court to choose your jail cell.'
        );
      }

      const guiltyLine = formatCourtLine(
        pick(COURT_GUILTY_LINES),
        { case: caseId, user: accusedTag }
      );

      await court.send(
        guiltyLine + '\n' +
        'Crime: ' + record.reason + '\n' +
        'Justification: ' + record.justification + '\n\n' +
        accusedTag + ' — please choose your jail using:\n' +
        'Use the commands: /choosejail case:' + caseId + ' cell:sfw  OR  /choosejail case:' + caseId + ' cell:nsfw'
      );

      return interaction.reply({ content: 'Guilty verdict recorded.', flags: 64 });
    }

    // Innocent
    record.status = 'innocent';
    const rec = getRecord(gState, record.nomineeId);
    rec.totalNotGuilty += 1;
    saveState();

    if (lounge) {
      await lounge.send(
        '🕊️ Case #' + caseId + ' — NOT GUILTY. The Motel Court has spoken.\n' +
        accusedName + ' walks free this time.'
      );
    }

    const innocentLine = formatCourtLine(
      pick(COURT_INNOCENT_LINES),
      { case: caseId, user: accusedTag }
    );

    await court.send(innocentLine);

    return interaction.reply({ content: 'Not guilty verdict recorded.', flags: 64 });
  }

  // /choosejail
  if (commandName === 'choosejail') {
    const caseId = interaction.options.getInteger('case', true);
    const cell = interaction.options.getString('cell', true);
    const record = gState.jail.cases[caseId];

    if (!record) return interaction.reply({ content: `Case #${caseId} not found.`, flags: 64 });
    if (record.status !== 'guilty') {
      return interaction.reply({ content: `Case #${caseId} is not awaiting jail selection.`, flags: 64 });
    }

    if (interaction.user.id !== record.nomineeId) {
      return interaction.reply({ content: `Only <@${record.nomineeId}> may choose their jail.`, flags: 64 });
    }

    const roleName = cell === 'sfw' ? ROLES.jail_sfw : ROLES.jail_nsfw;
    const role = findRole(guild, roleName);
    if (!role) return interaction.reply({ content: `Role not found: ${roleName}`, flags: 64 });

    const member = await guild.members.fetch(record.nomineeId);
    await member.roles.add(role);

    record.cell = cell;
    record.status = 'jailed';
    record.timestamps.jailedAt = Date.now();
    saveState();

    const court = await findChannel(guild, CHANNELS.court);
    const lounge = await findChannel(guild, CHANNELS.lounge);

    const accusedTag = `<@${record.nomineeId}>`;
    const accusedName = guild.members.cache.get(record.nomineeId)?.user.username || 'the accused';
    const cellLabel = cell === 'sfw' ? 'SFW Jail' : 'NSFW Jail';

    if (court) {
      const jailLine = formatCourtLine(
        pick(COURT_JAIL_LINES),
        { case: caseId, user: accusedTag, cell: cellLabel }
      );
      await court.send(jailLine + '\nPunishment suggestions may now begin!');
    }

    if (lounge) {
      await lounge.send(
        '🔒 ' + accusedName + ' is now in the **' + cellLabel +
        '** for Case #' + caseId + '.'
      );
    }

    return interaction.reply({ content: 'Jail chosen.', flags: 64 });
  }

  // /sentence
  if (commandName === 'sentence') {
    const caseId = interaction.options.getInteger('case', true);
    const punishment = interaction.options.getString('punishment', true);
    const record = gState.jail.cases[caseId];

    if (!record) return interaction.reply({ content: `Case #${caseId} not found.`, flags: 64 });
    if (record.status !== 'jailed') {
      return interaction.reply({ content: `Case #${caseId} is not in sentencing stage.`, flags: 64 });
    }

    record.punishment = punishment;
    record.status = 'awaiting_punishment';
    record.timestamps.sentencedAt = Date.now();
    saveState();

    const court = await findChannel(guild, CHANNELS.court);
    const lounge = await findChannel(guild, CHANNELS.lounge);

    const accusedTag = `<@${record.nomineeId}>`;
    const accusedName = guild.members.cache.get(record.nomineeId)?.user.username || 'the accused';

    const sentenceLine = formatCourtLine(
      pick(COURT_SENTENCE_LINES),
      { case: caseId, user: accusedTag }
    );

    // Announce in court
    if (court) {
      await court.send(
        sentenceLine + '\n' +
        accusedTag + ' must:\n> ' + punishment
      );
    }

    // Also announce in the correct jail channel (SFW or NSFW)
    if (record.cell) {
      let jailChannel = null;
      if (record.cell === 'sfw') {
        jailChannel = await findChannel(guild, CHANNELS.jail_sfw);
      } else if (record.cell === 'nsfw') {
        jailChannel = await findChannel(guild, CHANNELS.jail_nsfw);
      }

      if (jailChannel) {
        await jailChannel.send(
          sentenceLine + '\n' +
          accusedTag + ' must:\n> ' + punishment
        );
      }
    }

    if (lounge) {
      await lounge.send(
        '🔨 ' + accusedName + ' has been officially sentenced for Case #' + caseId + '.'
      );
    }

    return interaction.reply({ content: 'Punishment set.', flags: 64 });
  }

  // /release
  if (commandName === 'release') {
    const caseId = interaction.options.getInteger('case', true);
    const record = gState.jail.cases[caseId];

    if (!record) return interaction.reply({ content: `Case #${caseId} not found.`, flags: 64 });
    if (record.status !== 'awaiting_punishment') {
      return interaction.reply({ content: `Case #${caseId} is not ready for release.`, flags: 64 });
    }

    const cell = record.cell;
    const roleName = cell === 'sfw' ? ROLES.jail_sfw : ROLES.jail_nsfw;
    const role = findRole(guild, roleName);
    if (role) {
      const member = await guild.members.fetch(record.nomineeId);
      await member.roles.remove(role);
    }

    record.status = 'released';
    record.timestamps.releasedAt = Date.now();

    const rec = getRecord(gState, record.nomineeId);
    rec.totalReleases += 1;
    saveState();

    const court = await findChannel(guild, CHANNELS.court);
    const lounge = await findChannel(guild, CHANNELS.lounge);

    const accusedTag = `<@${record.nomineeId}>`;
    const accusedName = guild.members.cache.get(record.nomineeId)?.user.username || 'the accused';

    if (court) {
      const releaseLine = formatCourtLine(
        pick(COURT_RELEASE_LINES),
        { case: caseId, user: accusedTag }
      );
      await court.send(releaseLine);
    }

    if (lounge) {
      await lounge.send(
        '🕊️ ' + accusedName + ' has completed their sentence for Case #' + caseId + '.'
      );
    }

    return interaction.reply({ content: 'User released.', flags: 64 });
  }

  // /record
  if (commandName === 'record') {
    const target = interaction.options.getUser('user', true);
    const rec = gState.records && gState.records[target.id];

    if (!rec) {
      return interaction.reply({
        content: `${target.username} has a clean Motel record... for now.`
      });
    }

    const headerLines = [
      `📂 **Motel Criminal Record for ${target.username}**`,
      '',
      `Total charges: **${rec.totalCharges || 0}**`,
      `Total guilty verdicts: **${rec.totalGuilty || 0}**`,
      `Total not guilty: **${rec.totalNotGuilty || 0}**`,
      `Total releases: **${rec.totalReleases || 0}**`
    ];

    // Detailed case list with crimes word-for-word
    let caseLines = [];
    if (rec.cases && rec.cases.length) {
      caseLines.push('', '**Case details:**');
      rec.cases.forEach((cid) => {
        const c = gState.jail.cases[cid];
        if (!c) return;

        const statusLabel = (c.status || 'unknown').toUpperCase();
        const punishmentText = c.punishment ? c.punishment : 'Not set yet';

        caseLines.push(
          `• **Case #${c.id} — ${statusLabel}**` +
          `\n  **Crime:** ${c.reason}` +
          `\n  **Justification:** ${c.justification}` +
          `\n  **Punishment:** ${punishmentText}`
        );
      });
    } else {
      caseLines.push('', 'Cases involved: none');
    }

    const lines = [...headerLines, ...caseLines];

    return interaction.reply({
      content: lines.join('\n')
    });
  }

  // /casearticle — newspaper-style writeup with quotes from court chat
  if (commandName === 'casearticle') {
    // NOTE: public for the whole motel — no flags here
    await interaction.deferReply();

    const caseId = interaction.options.getInteger('case', true);
    const record = gState.jail.cases[caseId];

    if (!record) {
      return interaction.editReply({
        content: `Case #${caseId} not found.`
      });
    }

    const accusedTag = `<@${record.nomineeId}>`;
    const accuserTag = `<@${record.nominatorId}>`;
    const statusLabel = (record.status || 'unknown').toUpperCase();
    const cellLabel = record.cell
      ? (record.cell === 'sfw' ? 'SFW Jail' : 'NSFW Jail')
      : 'No jail selected';
    const punishmentText = record.punishment || 'No punishment recorded yet.';

    const summaryContext =
      `Moonlit Motel Court Case #${record.id}\n` +
      `Status: ${statusLabel}\n` +
      `Accused: ${accusedTag}\n` +
      `Accuser: ${accuserTag}\n` +
      `Crime: ${record.reason}\n` +
      `Justification: ${record.justification}\n` +
      `Chosen cell: ${cellLabel}\n` +
      `Punishment: ${punishmentText}\n`;

    // Pull quotes from Court of Weirdos transcript
    let quoteBlock = 'No notable quotes were captured for this case.';
    try {
      const court = await findChannel(guild, CHANNELS.court);
      if (court) {
        const transcript = gState.transcripts[court.id] || [];
        const startTime = record.timestamps?.nominatedAt || 0;

        // Only messages after nomination
        let relevant = transcript.filter(m => m.ts >= startTime);

        // Basic filters: length & non-empty
        relevant = relevant.filter(m => {
          const content = (m.content || '').trim();
          return content.length >= 5 && content.length <= 200;
        });

        if (relevant.length > 0) {
          const keywords = [
            'guilty', 'innocent', 'jail', 'sentence', 'sentenced',
            'court', 'verdict', 'style', 'crime', 'case'
          ];
          const accusedMention = `<@${record.nomineeId}>`;
          const accuserMention = `<@${record.nominatorId}>`;

          const good = relevant.filter(m => {
            const content = m.content || '';
            const lc = content.toLowerCase();
            return (
              keywords.some(k => lc.includes(k)) ||
              content.includes(accusedMention) ||
              content.includes(accuserMention)
            );
          });

          const pool = good.length ? good : relevant;
          const selected = pool.slice(0, 5);

          if (selected.length > 0) {
            quoteBlock = selected.map(m => {
              const content = (m.content || '').replace(/\n/g, ' ').trim();
              return `<@${m.user}> said: "${content}"`;
            }).join('\n');
          }
        }
      }
    } catch (err) {
      console.error('Error collecting case quotes:', err);
      // keep default quoteBlock
    }

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are Chad writing a dramatic, tongue-in-cheek motel newspaper article ' +
              'about a court case at the Moonlit Motel. Write 2–4 short paragraphs, maximum 300 words. ' +
              'Lean into noir / tabloid drama, but keep it playful and safe for a Discord community.'
          },
          {
            role: 'user',
            content:
              'Generate a newspaper-style article describing this case, including the accuser, ' +
              'accused, crime, verdict/status, jail cell, and punishment. Use their Discord mentions as written.\n\n' +
              summaryContext +
              '\n\nWitness quotes from the Court of Weirdos chat (use some of them in the story):\n' +
              quoteBlock
          }
        ]
      });

      const article = completion.choices[0].message.content;

      return interaction.editReply({
        content: `📰 **Moonlit Motel Gazette — Case #${caseId}**\n\n${article}`
      });
    } catch (err) {
      console.error('Error generating case article:', err);
      return interaction.editReply({
        content: 'The printing press jammed, sweetheart. Try again in a bit.'
      });
    }
  }
});



// ===============================
// PART 4 — CHAD PERSONALITY ENGINE + TRANSCRIPTS + AMBIENT
// ===============================

// TRANSCRIPT LOGGING
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const gState = getGuildState(msg.guild.id);
  if (!gState.transcripts[msg.channel.id]) gState.transcripts[msg.channel.id] = [];

  gState.transcripts[msg.channel.id].push({
    user: msg.author.id,
    content: msg.content,
    ts: Date.now()
  });

  if (gState.transcripts[msg.channel.id].length > 200) {
    gState.transcripts[msg.channel.id].shift();
  }
  saveState();
});

// SUMMARIZER — "Chad, summarize"
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (!msg.content.toLowerCase().startsWith('chad, summarize')) return;

  const gState = getGuildState(msg.guild.id);
  const transcript = gState.transcripts[msg.channel.id] || [];

  if (transcript.length === 0) return msg.reply("There's nothing to summarize, sunshine.");

  const formatted = transcript.map(t => `<@${t.user}>: ${t.content}`).join(' ');

  try {
    const summary = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Chad — confident, sarcastic, flirtatious. Summarize with swagger.' },
        { role: 'user', content: formatted }
      ]
    });
    msg.reply(summary.choices[0].message.content);
  } catch (err) {
    console.error(err);
    msg.reply('My bad, princess — the spirits glitched.');
  }
});

// CHAD PERSONALITY WEIGHTING
function chadTone() {
  const r = Math.random();
  if (r < 0.30) return 'snark';
  if (r < 0.50) return 'haunt';
  return 'chad';
}

function chadLine(tone) {
  if (tone === 'snark') {
    return brain.petty[Math.floor(Math.random() * brain.petty.length)] || "You're adorable when you're wrong.";
  }
  if (tone === 'haunt') {
    return brain.ambient[Math.floor(Math.random() * brain.ambient.length)] || 'The halls whisper about you, doll.';
  }
  return brain.normal[Math.floor(Math.random() * brain.normal.length)] || 'Relax — Chad’s here.';
}

// MAIN CHAT HANDLER — "Chad ..."
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const content = msg.content.trim().toLowerCase();
  if (!content.startsWith('chad')) return;

  const tone = chadTone();
  const vibe = chadLine(tone);

  try {
    const reply = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: "You are CHAD — 6'4 of arrogant charm, chaotic flirt energy, confident, spooky at times, never apologetic unless sarcastic." },
        { role: 'user', content: msg.content },
        { role: 'assistant', content: vibe }
      ]
    });

    msg.reply(reply.choices[0].message.content);
  } catch (err) {
    console.error(err);
    msg.reply('The lights flickered too hard — try again, sweetheart.');
  }
});

// AMBIENT HAUNTINGS — Every 3 hours
setInterval(() => {
  const line = brain.ambient[Math.floor(Math.random() * brain.ambient.length)] ||
    'Something’s breathing behind the vending machine again.';

  client.guilds.cache.forEach(async (guild) => {
    const lounge = guild.channels.cache.find(ch => ch.name === CHANNELS.lounge);
    if (lounge) lounge.send(`🕯️ ${line}`);
  });
}, 3 * 60 * 60 * 1000);



// ===============================
// PART 5 — FINAL LOGIN
// ===============================

client.on('error', console.error);
client.on('warn', console.warn);

client.login(process.env.DISCORD_TOKEN).then(() => {
  console.log('Chad 2.0 is ALIVE. The neon hums.');
}).catch(err => {
  console.error('Login failed:', err);
});

// ===============================
// CHAD 2.0 — COMPLETE
// ===============================
