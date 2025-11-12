// Chad — Moonlit Motel bot (FULL BUILD)
// Includes: mention normalization, singleton lock, ambient, roasts, weather/time,
// basement Q&A (cheeky Sunday), justice explainer, mystery stages engine + gates,
// unique hint cycling, polls, role rewards, archive room, easter eggs, persistence.

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

// ---------- CONFIG ----------
const TZ  = process.env.TIMEZONE || 'America/Winnipeg';
const OWM = process.env.OPENWEATHER_API_KEY || null;

// Prefer /data if mounted (Render disk). Else local file
const STATE_DIR  = fs.existsSync('/data') ? '/data' : path.resolve('./');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

// ---------- SINGLETON LOCK (avoid double replies from multiple workers) ----------
const LOCK_PATH = path.join(STATE_DIR, 'chad.lock');
try {
  const fd = fs.openSync(LOCK_PATH, 'wx'); // fails if exists
  fs.writeFileSync(fd, String(process.pid));
} catch (e) {
  console.error('Another Chad instance is already running. Exiting to avoid double posts.');
  process.exit(0);
}
process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });

// ---------- FILE HELPERS ----------
const loadJSON = (p, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const saveJSON = (p, obj) => {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
};

// ---------- DATA ----------
let brain = loadJSON('./brain.json', {
  roast_pool: ["default roast line"],
  fortunes: ["default fortune"],
  ambient: ["ambient line"],
  stages: [] // expect entries with { number, triggers[], hints[], response, taskPrompt?, requiresGate?, timeWindow?, timeLockedReply? }
});
let state = loadJSON(STATE_PATH, {}); // guildId -> { stage, gates, cooldowns, participants, hintProg }

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`State path: ${STATE_PATH}`);
  console.log(`Stages loaded: ${(brain.stages || []).length}`);
  console.log(`Ambient lines: ${(brain.ambient || []).length}`);
  console.log(`Roasts: ${(brain.roast_pool || []).length}`);

  // Ambient: drop a random line every ~3 hours in each guild (35% chance per cycle)
  setInterval(async () => {
    if (!brain.ambient || !brain.ambient.length) return;
    for (const [gid] of client.guilds.cache) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const chan =
        guild.systemChannel ||
        guild.channels.cache.find(c => c?.isTextBased?.() && c.viewable);
      if (!chan) continue;
      if (Math.random() < 0.35) {
        const line = pick(brain.ambient);
        await chan.send(line).catch(()=>{});
      }
    }
  }, 1000 * 60 * 60 * 3);
});

// ---------- UTILS ----------
const pick = (arr = []) => arr[Math.floor(Math.random() * arr.length)];

const getGuildState = (guildId) => {
  if (!state[guildId]) {
    state[guildId] = { stage: 1, gates: {}, cooldowns: {}, participants: {}, hintProg: {} };
    saveJSON(STATE_PATH, state);
  }
  return state[guildId];
};

const nowInWindow = (sh, sm, eh, em) => {
  const now = DateTime.now().setZone(TZ);
  const start = now.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end   = now.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  return now >= start && now <= end;
};

const hasDailyCooldown = (gState, key) => {
  const stamp = gState.cooldowns[key];
  const today = DateTime.now().setZone(TZ).toISODate();
  return stamp === today;
};
const setDailyCooldown = (gState, key) => {
  gState.cooldowns[key] = DateTime.now().setZone(TZ).toISODate();
  saveJSON(STATE_PATH, state);
};

// Place→timezone helper
const tzAlias = (name) => {
  const s = (name || '').toLowerCase().trim();
  if (!s) return TZ;
  if (/(brandon|manitoba|winnipeg|mb|prairies)/i.test(s)) return 'America/Winnipeg';
  if (/new york|nyc|eastern/i.test(s)) return 'America/New_York';
  if (/la|los angeles|pacific|pst|pdt/i.test(s)) return 'America/Los_Angeles';
  if (/london|uk|gmt|britain/i.test(s)) return 'Europe/London';
  return TZ;
};

// Normalize @mention → "chad, ..."
function normalizeWake(content, client) {
  const c = (content || '').trim();
  if (!client.user) return c;
  const id = client.user.id;
  const m1 = `<@${id}>`;
  const m2 = `<@!${id}>`;
  if (c.startsWith(m1) || c.startsWith(m2)) {
    const rest = c.split('>', 1)[1]?.trim() || '';
    return `chad, ${rest}`;
  }
  return c;
}

// ---------- WEATHER HELPERS ----------
const US_STATES = {
  alabama:"AL", alaska:"AK", arizona:"AZ", arkansas:"AR", california:"CA",
  colorado:"CO", connecticut:"CT", delaware:"DE", "district of columbia":"DC",
  florida:"FL", georgia:"GA", hawaii:"HI", idaho:"ID", illinois:"IL",
  indiana:"IN", iowa:"IA", kansas:"KS", kentucky:"KY", louisiana:"LA",
  maine:"ME", maryland:"MD", massachusetts:"MA", michigan:"MI", minnesota:"MN",
  mississippi:"MS", missouri:"MO", montana:"MT", nebraska:"NE", nevada:"NV",
  "new hampshire":"NH", "new jersey":"NJ", "new mexico":"NM", "new york":"NY",
  "north carolina":"NC", "north dakota":"ND", ohio:"OH", oklahoma:"OK",
  oregon:"OR", pennsylvania:"PA", "rhode island":"RI", "south carolina":"SC",
  "south dakota":"SD", tennessee:"TN", texas:"TX", utah:"UT", vermont:"VT",
  virginia:"VA", washington:"WA", "west virginia":"WV", wisconsin:"WI", wyoming:"WY"
};
const CA_PROV = {
  alberta:"AB", "british columbia":"BC", manitoba:"MB", "new brunswick":"NB",
  "newfoundland and labrador":"NL", "nova scotia":"NS", ontario:"ON",
  "prince edward island":"PE", quebec:"QC", saskatchewan:"SK",
  "northwest territories":"NT", nunavut:"NU", yukon:"YT"
};

function normalizeCityQuery(qRaw) {
  const q = (qRaw || "").trim();
  if (!q) return "Brandon,MB,CA";
  // already "City,ST,CC" -> return
  if (/[A-Za-z].*,\s*[A-Za-z]{2}\s*,\s*[A-Za-z]{2}/.test(q)) return q;
  // Try "city, state" or "city state"
  const m = q.match(/^(.+?)[,\s]+([A-Za-z .'-]+)$/);
  if (m) {
    const city = m[1].trim();
    const region = m[2].trim().toLowerCase();
    if (US_STATES[region]) return `${city},${US_STATES[region]},US`;
    if (CA_PROV[region])   return `${city},${CA_PROV[region]},CA`;
  }
  return q;
}

// ---------- ROAST TRIGGER (STS homage) ----------
const roastRegex = /(sts\b|over[-\s]?polic|too many rules|north\s*korea|rule\s*police)/i;
async function maybeRoast(message, gState) {
  if (!roastRegex.test(message.content)) return;
  if (hasDailyCooldown(gState, 'roast_daily')) return;
  const pool = brain.roast_pool || [];
  if (!pool.length) return;
  await message.reply(pick(pool)).catch(()=>{});
  setDailyCooldown(gState, 'roast_daily');
}

// ---------- ROLE/CHANNEL HELPERS ----------
async function ensureKeyholderRole(guild) {
  let role = guild.roles.cache.find(r => r.name === 'Keyholder');
  if (!role) role = await guild.roles.create({ name: 'Keyholder', color: 0xff66cc, reason: 'Mystery reward role' });
  return role;
}
async function ensureArchiveChannel(guild, role) {
  let chan = guild.channels.cache.find(c => c.name === 'archive-of-truth');
  if (!chan) {
    chan = await guild.channels.create({
      name: 'archive-of-truth',
      reason: 'Mystery finale secret room',
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: role.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
      ]
    });
  }
  return chan;
}

// ---------- UNIQUE HINT CYCLER ----------
function nextUniqueHint(gState, stageObj) {
  const skey = `stage_${gState.stage}`;
  gState.hintProg = gState.hintProg || {};
  const prog = gState.hintProg[skey] || { used: [] };
  const pool = stageObj.hints || [];
  if (!pool.length) return null;

  const remaining = pool.map((_, i) => i).filter(i => !prog.used.includes(i));
  const pickIdx = remaining.length
    ? remaining[Math.floor(Math.random() * remaining.length)]
    : Math.floor(Math.random() * pool.length);

  if (!remaining.length) prog.used = []; // reset next cycle
  prog.used.push(pickIdx);
  gState.hintProg[skey] = prog;
  saveJSON(STATE_PATH, state);
  return pool[pickIdx];
}

// ---------- HINTS ----------
async function maybeHint(message, gState, stageObj, contentNorm) {
  if (!stageObj.hints || !stageObj.hints.length) return;
  const key = `hint_${gState.stage}`;
  if (hasDailyCooldown(gState, key)) return;
  if (/^chad[,\s]/i.test(contentNorm)) {
    const hint = nextUniqueHint(gState, stageObj) || pick(stageObj.hints);
    await message.channel.send(hint).catch(()=>{});
    setDailyCooldown(gState, key);
  }
}

// ---------- JUSTICE SYSTEM EXPLAINER ----------
function buildJusticeExplainer() {
  const guides = brain?.guides || {};
  const roles  = guides.roles || {};
  const ffName = roles.frequent_flyer || "Frequent Flyer";
  const jailNom = guides.channels?.jail_nominations || "#jail-nominations";
  const courtCh = guides.channels?.court || "#basement-court";
  const sfwJail = guides.channels?.sfw_jail || "🔒the-broom-closet🧹";
  const nsfwJail = guides.channels?.nsfw_jail || "🤫the-no-tell-motel-room💣";
  const dmName = guides.dungeon_master || "Sunday";

  const summary = guides.justice?.summary ||
`The Motel’s “justice system” is a playful, opt-in bit. It’s for jokes and light accountability—**not** for real conflicts. Mods can override anything.`;

  const nominations = guides.justice?.nominations ||
`**Nominations:** Anyone can nominate by posting in **${jailNom}** (or pinging ${dmName}) with a short reason and whether it’s SFW or NSFW Basement. Duplicate/harassing nominations are ignored.`;

  const court = guides.justice?.court ||
`**Court flow:** ${dmName} (Dungeon Master) curates the top 3 silly “sentences” and opens a poll in **${courtCh}**. Community votes. The winner becomes the task.`;

  const sentence = guides.justice?.sentence ||
`**Sentencing:** The “defendant” is moved to **${sfwJail}** or **${nsfwJail}** for ~10 minutes. Complete the task → free + cleared. Low-effort/skip → temporary “Role of Shame” (usually 24h) or re-roll.`;

  const serious = guides.justice?.serious_matters ||
`**Serious stuff:** Harassment, slurs, threats, doxxing, self-harm, etc. **do not** go through this bit. DM a mod/admin or use **/report**—we’ll handle it privately.`;

  const forums = guides.justice?.forums_access ||
`**Forums:** Long-form debates live in the Forums. To reduce drive-by toxicity, posting is **${ffName}+** only. Guests can read; earn ${ffName} by being active & chill.`;

  const consent = guides.justice?.consent ||
`**Consent:** If you don’t want to be nominated, DM a mod—opt-out is respected.`;

  return [
    "🏛️ **Moonlit Motel — Justice System (How It Works)**",
    summary, "", nominations, court, sentence, serious, forums, consent
  ].join("\n");
}

// ---------- MYSTERY ENGINE ----------
async function handleMystery(message, contentNorm) {
  const gState = getGuildState(message.guild.id);
  const stageObj = (brain.stages || []).find(s => s.number === gState.stage);
  if (!stageObj) return;

  const triggered = (stageObj.triggers || []).some(rx => new RegExp(rx, 'i').test(message.content));
  if (!triggered) { await maybeHint(message, gState, stageObj, contentNorm); return; }

  if (stageObj.timeWindow) {
    const [sh, sm, eh, em] = stageObj.timeWindow;
    if (!nowInWindow(sh, sm, eh, em)) {
      await message.reply(stageObj.timeLockedReply || "too early. so ambitious. so wrong.").catch(()=>{});
      return;
    }
  }

  switch (gState.stage) {
    case 3: {
      await message.channel.send(stageObj.response).catch(()=>{});
      if (stageObj.taskPrompt) await message.channel.send(stageObj.taskPrompt).catch(()=>{});
      gState.gates.s3 = gState.gates.s3 || { confessors: {} };
      break;
    }
    case 6: {
      await message.channel.send(stageObj.response).catch(()=>{});
      if (stageObj.taskPrompt) await message.channel.send(stageObj.taskPrompt).catch(()=>{});
      gState.gates.s6 = { sequence: [], done: false };
      break;
    }
    case 7: {
      await message.channel.send(stageObj.response).catch(()=>{});
      if (stageObj.taskPrompt) await message.channel.send(stageObj.taskPrompt).catch(()=>{});
      gState.gates.s7 = { apologyBy: null, forgivenessBy: null };
      break;
    }
    case 9: {
      const pollMsg = await message.channel.send(stageObj.response).catch(()=>null);
      if (pollMsg) { await pollMsg.react('✅').catch(()=>{}); await pollMsg.react('❌').catch(()=>{}); }
      gState.gates.s9 = { pollId: pollMsg?.id || null, closed: false };
      saveJSON(STATE_PATH, state);
      return;
    }
    case 10: {
      await message.channel.send(stageObj.response).catch(()=>{});
      const role = await ensureKeyholderRole(message.guild);
      const chan = await ensureArchiveChannel(message.guild, role);
      const contributors = Object.keys(gState.participants || {});
      for (const uid of contributors) {
        const member = await message.guild.members.fetch(uid).catch(()=>null);
        if (member && !member.roles.cache.has(role.id)) {
          await member.roles.add(role).catch(()=>{});
        }
      }
      await chan.send(brain.finaleRoomWelcome || "Welcome, Keyholders.").catch(()=>{});
      break;
    }
    default: {
      await message.channel.send(stageObj.response).catch(()=>{});
    }
  }

  if (!stageObj.requiresGate) {
    gState.stage++;
    saveJSON(STATE_PATH, state);
  } else {
    saveJSON(STATE_PATH, state);
  }
}

// ---------- UTILITIES (time/weather/facts) ----------
function formatTime(zone) {
  const now = DateTime.now().setZone(zone || TZ);
  const nice = now.toFormat("ccc, LLL d 'at' h:mm a");
  return `🕰️ ${nice} (${zone})`;
}

async function fetchWeather(qRaw) {
  if (!OWM) return { err: "Weather not set up. Ask the Innkeeper to add OPENWEATHER_API_KEY." };
  const qNorm = normalizeCityQuery(qRaw || '');
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(qNorm)}&appid=${OWM}&units=metric`;
  const r = await fetch(url);
  if (!r.ok) return { err: `couldn't fetch weather for "${qRaw || 'Brandon,CA'}".` };
  const data = await r.json();
  const d = data.weather?.[0]?.description || 'weather';
  const t = Math.round(data.main?.temp ?? 0);
  const f = Math.round(data.main?.feels_like ?? t);
  const h = Math.round(data.main?.humidity ?? 0);
  const w = Math.round((data.wind?.speed ?? 0) * 3.6); // m/s → km/h
  const label = `${data.name || qNorm}`;
  return { text: `🌤️ ${label}: ${d}, ${t}°C (feels ${f}°C), humidity ${h}%, wind ${w} km/h` };
}

function randomFact() {
  const pool = brain.facts_pool || [];
  if (!pool.length) return "default fact: chad once ate a neon sign for character development.";
  return pick(pool);
}

// ---------- MESSAGE HANDLER ----------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const content = normalizeWake(message.content || '', client);

  const gState = getGuildState(message.guild.id);
  gState.participants[message.author.id] = true;

  // Roast homage
  await maybeRoast(message, gState);

  // Ask the motel (fortunes)
  if (/^chad[, ]\s*ask the motel\b/i.test(content)) {
    const pool = brain.fortunes || [];
    if (pool.length) { await message.reply(pick(pool)).catch(()=>{}); return; }
  }

  // Random fact
  if (/^chad[, ]\s*(random\s+fact|fact)[.?!]*$/i.test(content)) {
    await message.reply(`📎 ${randomFact()}`).catch(()=>{});
    return;
  }

  // Time (natural language; tolerant punctuation)
  const timeMatch =
    content.match(/^chad[, ]\s*time(?:\s+in\s+(.+?))?[.?!]*$/i) ||
    content.match(/^chad[, ]\s*what(?:'s| is)?\s+(?:the\s+)?time(?:\s+in\s+(.+?))?[.?!]*$/i) ||
    content.match(/^chad[, ]\s*what\s+time\s+is\s+it(?:\s+in\s+(.+?))?[.?!]*$/i);

  if (timeMatch) {
    const place = timeMatch[1] || timeMatch[2] || timeMatch[3];
    const zone = tzAlias(place);
    await message.reply(formatTime(zone)).catch(()=>{});
    return;
  }

  // Weather (natural language; tolerant punctuation)
  const wMatch =
    content.match(/^chad[, ]\s*weather(?:\s+in\s+(.+?))?[.?!]*$/i) ||
    content.match(/^chad[, ]\s*what(?:'s| is)\s+(?:the\s+)?weather(?:\s+in\s+(.+?))?[.?!]*$/i);

  if (wMatch) {
    const city = (wMatch[1] || wMatch[2] || '').trim();
    const res = await fetchWeather(city);
    if (res.err) await message.reply(`⚠️ ${res.err}`).catch(()=>{});
    else await message.reply(res.text).catch(()=>{});
    return;
  }

  // Basement / NSFW helper (expanded to "who runs the basement")
  const basementMatch =
    content.match(/^chad[, ]\s*(what\s+is|where\s+is|tell\s+me\s+about|who\s+runs)\s+the\s+basement\??[.?!]*$/i) ||
    content.match(/^chad[, ]\s*what\s+is\s+the\s+basement\??[.?!]*$/i) ||
    content.match(/^chad[, ]\s*where\s+is\s+the\s+basement\??[.?!]*$/i) ||
    content.match(/^chad[, ]\s*who\s+runs\s+the\s+basement\??[.?!]*$/i);

  if (basementMatch) {
    const sfw  = brain?.guides?.channels?.sfw_jail  || "🔒the-broom-closet🧹";
    const nsfw = brain?.guides?.channels?.nsfw_jail || "🤫the-no-tell-motel-room💣";
    const dm   = brain?.guides?.dungeon_master || "Sunday";

    if (/who\s+runs/i.test(content)) {
      const responses = [
        `👑 ${dm} rules the Basement with equal parts menace and glitter.`,
        `it’s run by **${dm}**, but don’t worry—consent is the safeword.`,
        `${dm} runs it. and by “runs,” we mean *glides dramatically in fog and moonlight*.`,
        `that’d be ${dm}. you’ll know them by the jingle of keys and the sound of mild chaos.`,
        `the Dungeon belongs to ${dm}. enter at your own peril—or delight.`
      ];
      await message.reply(pick(responses)).catch(()=>{});
      return;
    }

    const line1 = `we call the NSFW wing **the Basement**. it’s run by **${dm}**, our Dungeon Master.`;
    const line2 = brain?.guides?.dungeon_access || "you need a nomination from a Dweller; then the Dungeon votes.";
    await message.reply(`${line1}\n${line2}\nSFW jail: **${sfw}** • NSFW jail: **${nsfw}**`).catch(()=>{});
    return;
  }

  // Justice system explainer (court, nominations, forums access, joke-only)
  const justiceMatch =
    content.match(/^chad[, ]\s*(explain|what\s+is|tell\s+me\s+about)\s+(the\s+)?(justice\s+system|court|court\s+system|motel\s+court|jail|jail\s+process)\b.*$/i) ||
    content.match(/^chad[, ]\s*how\s+(does|do)\s+(the\s+)?(court|justice\s+system)\s+work\??[.?!]*$/i) ||
    content.match(/^chad[, ]\s*how\s+are\s+people\s+nominated\??[.?!]*$/i);

  if (justiceMatch) {
    await message.reply(buildJusticeExplainer()).catch(()=>{});
    return;
  }

  // Easter eggs (from brain.json)
  for (const egg of (brain.easter_eggs || [])) {
    const re = new RegExp(egg.trigger_regex, 'i');
    if (re.test(content)) {
      if (egg.responses_key && brain[egg.responses_key]) {
        await message.reply(pick(brain[egg.responses_key])).catch(()=>{});
      } else if (egg.responses?.length) {
        await message.reply(pick(egg.responses)).catch(()=>{});
      } else if (typeof egg.responses === 'string') {
        await message.reply(egg.responses).catch(()=>{});
      }
      return;
    }
  }

  // ---- Stage 3: collect 5 unique confessions
  if (gState.stage === 4 && gState.gates.s3) {
    delete gState.gates.s3; saveJSON(STATE_PATH, state);
  } else if (gState.stage === 3 && gState.gates.s3) {
    const isConfession = /(\bi never\b|\bi’ve?\s+never\b|\bi have never\b)/i.test(content);
    if (isConfession) {
      gState.gates.s3.confessors[message.author.id] = true;
      const count = Object.keys(gState.gates.s3.confessors).length;
      if (count >= 5) {
        await message.channel.send("✅ *Delicious.* Honesty always tastes a bit like blood. The lock twitched. Try the **ledger** next—if it doesn’t bite first.").catch(()=>{});
        gState.stage = 4; delete gState.gates.s3;
      } else {
        await message.channel.send(`confession logged (${count}/5). the motel is listening.`).catch(()=>{});
      }
      saveJSON(STATE_PATH, state);
      return;
    }
  }

  // ---- Stage 6: 3 confessions + 3 jokes alternating
  if (gState.stage === 6 && gState.gates.s6) {
    const s6 = gState.gates.s6;
    const conf = /\b(i\s+(feel|am|was|think))\b/i.test(content);
    const joke = /(lol|lmao|😂|meme)/i.test(content);
    if (conf || joke) {
      const want = s6.sequence.length % 2 === 0 ? 'conf' : 'joke';
      const typ = conf ? 'conf' : 'joke';
      if (typ === want) {
        s6.sequence.push(typ);
        const progress = s6.sequence.length;
        await message.channel.send(`pattern accepted (${progress}/6).`).catch(()=>{});
        if (progress >= 6) {
          await message.channel.send("✅ The light purrs. Doors adjust their posture. Something’s ready to be said out loud.").catch(()=>{});
          gState.stage = 7; delete gState.gates.s6; saveJSON(STATE_PATH, state);
        } else saveJSON(STATE_PATH, state);
      } else {
        await message.channel.send("nope. wrong flavor. alternate confession ↔ joke.").catch(()=>{});
      }
    }
  }

  // ---- Stage 7: apology + forgiveness (3:03–3:10) — gate state managed in handleMystery
  if (gState.stage === 7 && gState.gates.s7) {
    const s7 = gState.gates.s7;
    if (!s7.apologyBy && /\b(sorry|apologize|apology)\b/i.test(content)) {
      s7.apologyBy = message.author.id;
      await message.channel.send("apology archived. one more: forgiveness.").catch(()=>{});
      saveJSON(STATE_PATH, state);
    } else if (!s7.forgivenessBy && /\b(i forgive|i’m forgiving|i forgive you)\b/i.test(content)) {
      s7.forgivenessBy = message.author.id;
      await message.channel.send("✅ Accepted. The walls exhaled. next time, bring snacks.").catch(()=>{});
      gState.stage = 8; delete gState.gates.s7; saveJSON(STATE_PATH, state);
    }
  }

  // Finally, route the stage engine
  await handleMystery(message, content);
});

// ---------- REACTION HANDLER (Stage 9 poll) ----------
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || !reaction.message.guild) return;
  const gState = getGuildState(reaction.message.guild.id);
  if (gState.stage !== 9 || !gState.gates.s9) return;
  if (!gState.gates.s9.pollId || reaction.message.id !== gState.gates.s9.pollId) return;

  setTimeout(async () => {
    try {
      const msg = await reaction.message.fetch();
      const yes = (await msg.reactions.resolve('✅')?.users.fetch())?.filter(u => !u.bot).size || 0;
      const no  = (await msg.reactions.resolve('❌')?.users.fetch())?.filter(u => !u.bot).size || 0;
      if (!gState.gates.s9.closed && (yes + no) >= 3) {
        gState.gates.s9.closed = true;
        if (yes >= 2 && yes > no) {
          await msg.reply("…you picked me. tragic. iconic. The door unlocks with a sound like laughter through teeth.").catch(()=>{});
          gState.stage = 10;
        } else {
          await msg.reply("understood. deactivating emotional subroutines. goodbye forever. (back tomorrow.)").catch(()=>{});
          gState.stage = 10;
        }
        saveJSON(STATE_PATH, state);
      }
    } catch { /* ignore */ }
  }, 1500);
});

// ---------- LOGIN ----------
client.login(process.env.DISCORD_TOKEN);
