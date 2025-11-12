// Chad — Moonlit Motel bot (FULL BUILD + auto-clearing lock)
// Features: mention normalization, singleton lock, ambient lines, roasts, time, weather (US/CA normalizer + geocode fallback),
// basement Q&A (cheeky Sunday), justice explainer, mystery engine + gates (3/6/7/9/10), unique hint cycling,
// poll handling, Keyholder role + archive room, easter eggs, persistence.

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

// ---------- CONFIG ----------
const TZ  = process.env.TIMEZONE || 'America/Winnipeg';
const OWM = process.env.OPENWEATHER_API_KEY || null; // OpenWeather API key (optional, but needed for weather)

const STATE_DIR  = fs.existsSync('/data') ? '/data' : path.resolve('./');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

// ---------- SINGLETON LOCK (auto-clears stale locks + cleans up on exit) ----------
const LOCK_PATH = path.join(STATE_DIR, 'chad.lock');
const MAX_LOCK_AGE_MS = 1000 * 60 * 30; // 30 min

try {
  const st = fs.statSync(LOCK_PATH);
  if (Date.now() - st.mtimeMs > MAX_LOCK_AGE_MS) {
    console.warn('🧹 Stale lock detected. Removing:', LOCK_PATH);
    fs.rmSync(LOCK_PATH, { force: true });
  }
} catch { /* no prior lock */ }

let _lockFd = null;
try {
  _lockFd = fs.openSync(LOCK_PATH, 'wx'); // fail if exists
  fs.writeFileSync(
    _lockFd,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)
  );
} catch {
  console.error('🚫 Another Chad instance is already running. Exiting to avoid double posts.');
  process.exit(0);
}

function releaseLockAndExit(code = 0) {
  try { if (_lockFd !== null) fs.closeSync(_lockFd); } catch {}
  try { fs.unlinkSync(LOCK_PATH); } catch {}
  process.exit(code);
}
['SIGINT','SIGTERM','SIGQUIT'].forEach(sig => process.on(sig, () => releaseLockAndExit(0)));
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); releaseLockAndExit(1); });
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); releaseLockAndExit(1); });
process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {}; });

// ---------- FILE HELPERS ----------
const loadJSON = (p, fallback = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const saveJSON = (p, obj) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };

// ---------- DATA ----------
let brain = loadJSON('./brain.json', {
  roast_pool: ["default roast line"],
  fortunes:  ["default fortune"],
  ambient:   ["ambient line"],
  facts_pool:["default fact: chad once ate a neon sign for character development."],
  stages: []
});
let state = loadJSON(STATE_PATH, {}); // guildId -> { stage, gates, cooldowns, participants, hintProg }

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`State path: ${STATE_PATH}`);
  console.log(`Stages: ${(brain.stages||[]).length} • Ambient: ${(brain.ambient||[]).length} • Roasts: ${(brain.roast_pool||[]).length}`);
  console.log(`OpenWeather key present: ${!!OWM}`);

  // Ambient chatter every ~3h, 35% chance per guild
  setInterval(async () => {
    if (!brain.ambient?.length) return;
    for (const [gid] of client.guilds.cache) {
      const g = client.guilds.cache.get(gid);
      if (!g) continue;
      const chan = g.systemChannel || g.channels.cache.find(c => c?.isTextBased?.() && c.viewable);
      if (!chan) continue;
      if (Math.random() < 0.35) {
        const line = pick(brain.ambient);
        await chan.send(line).catch(()=>{});
      }
    }
  }, 1000 * 60 * 60 * 3);
});

// ---------- UTILS ----------
const pick = (arr=[]) => arr[Math.floor(Math.random() * arr.length)];
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
const hasDailyCooldown = (gState, key) => gState.cooldowns[key] === DateTime.now().setZone(TZ).toISODate();
const setDailyCooldown = (gState, key) => { gState.cooldowns[key] = DateTime.now().setZone(TZ).toISODate(); saveJSON(STATE_PATH, state); };

// Place→timezone
const tzAlias = (name) => {
  const s = (name || '').toLowerCase().trim();
  if (!s) return TZ;
  if (/(brandon|manitoba|winnipeg|mb|prairies)/i.test(s)) return 'America/Winnipeg';
  if (/new york|nyc|eastern/i.test(s)) return 'America/New_York';
  if (/la|los angeles|pacific|pst|pdt/i.test(s)) return 'America/Los_Angeles';
  if (/london|uk|gmt|britain/i.test(s)) return 'Europe/London';
  return TZ;
};

// Mention → "chad, ..."
function normalizeWake(content, client) {
  const c = (content || '').trim();
  if (!client.user) return c;
  const id = client.user.id;
  if (c.startsWith(`<@${id}>`) || c.startsWith(`<@!${id}>`)) {
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
  if (/[A-Za-z].*,\s*[A-Za-z]{2}\s*,\s*[A-Za-z]{2}/.test(q)) return q; // already City,ST,CC
  const m = q.match(/^(.+?)[,\s]+([A-Za-z .'-]+)$/);
  if (m) {
    const city = m[1].trim();
    const region = m[2].trim().toLowerCase();
    if (US_STATES[region]) return `${city},${US_STATES[region]},US`;
    if (CA_PROV[region])   return `${city},${CA_PROV[region]},CA`;
  }
  return q;
}

// ---------- ROAST TRIGGER ----------
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
`**Nominations:** Post in **${jailNom}** (or ping ${dmName}) with a short reason and whether it’s SFW or NSFW Basement. Duplicate/harassing nominations are ignored.`;

  const court = guides.justice?.court ||
`**Court flow:** ${dmName} curates the top 3 silly “sentences” and opens a poll in **${courtCh}**. Community votes.`;

  const sentence = guides.justice?.sentence ||
`**Sentencing:** The “defendant” chills in **${sfwJail}** or **${nsfwJail}** ~10 minutes. Complete the task → free + cleared. Low-effort/skip → temporary “Role of Shame” (≈24h) or re-roll.`;

  const serious = guides.justice?.serious_matters ||
`**Serious stuff:** Harassment, slurs, threats, doxxing, self-harm, etc. **do not** use the bit. DM a mod or use /report—handled privately.`;

  const forums = guides.justice?.forums_access ||
`**Forums:** Long-form debates live in the Forums. Posting is **${ffName}+** to dodge drive-by weird ideology. Guests can read.`;

  const consent = guides.justice?.consent ||
`**Consent:** DM a mod to opt-out of nominations—always respected.`;

  return ["🏛️ **Moonlit Motel — Justice System (How It Works)**", summary, "", nominations, court, sentence, serious, forums, consent].join("\n");
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

  if (!stageObj.requiresGate) { gState.stage++; saveJSON(STATE_PATH, state); }
  else { saveJSON(STATE_PATH, state); }
}

// ---------- UTILITIES (time/weather/facts) ----------
function formatTime(zone) {
  const now = DateTime.now().setZone(zone || TZ);
  const nice = now.toFormat("ccc, LLL d 'at' h:mm a");
  return `🕰️ ${nice} (${zone})`;
}
async function fetchWeather(qRaw) {
  if (!OWM) return { err: "Weather not set up. Ask the Innkeeper to add OPENWEATHER_API_KEY." };

  const original = (qRaw || '').trim();
  const qNorm = normalizeCityQuery(original);

  // try by name
  const byName = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(qNorm)}&appid=${OWM}&units=metric`;
  let r = await fetch(byName);
  if (!r.ok) {
    // fallback: geocode to lat/lon, then fetch by coords
    const geoURL = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(qNorm)}&limit=1&appid=${OWM}`;
    const gr = await fetch(geoURL);
    if (gr.ok) {
      const g = await gr.json();
      if (Array.isArray(g) && g.length) {
        const { lat, lon, name, state: st, country } = g[0];
        const byCoord = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM}&units=metric`;
        r = await fetch(byCoord);
        if (r.ok) {
          const data = await r.json();
          const d = data.weather?.[0]?.description || 'weather';
          const t = Math.round(data.main?.temp ?? 0);
          const f = Math.round(data.main?.feels_like ?? t);
          const h = Math.round(data.main?.humidity ?? 0);
          const w = Math.round((data.wind?.speed ?? 0) * 3.6);
          const label = `${name || data.name || qNorm}${st ? ', ' + st : ''}${country ? ', ' + country : ''}`;
          return { text: `🌤️ ${label}: ${d}, ${t}°C (feels ${f}°C), humidity ${h}%, wind ${w} km/h` };
        }
      }
    }
    return { err: `couldn't fetch weather for "${original || qNorm}".` };
  } else {
    const data = await r.json();
    const d = data.weather?.[0]?.description || 'weather';
    const t = Math.round(data.main?.temp ?? 0);
    const f = Math.round(data.main?.feels_like ?? t);
    const h = Math.round(data.main?.humidity ?? 0);
    const w = Math.round((data.wind?.speed ?? 0) * 3.6);
    const label = `${data.name || qNorm}`;
    return { text: `🌤️ ${label}: ${d}, ${t}°C (feels ${f}°C), humidity ${h}%, wind ${w} km/h` };
  }
}
function randomFact() {
  const pool = brain.facts_pool || [];
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

  // Basement / NSFW helper (+ cheeky "who runs" replies)
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

  // ---- Stage 3 gate: collect 5 unique confessions
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

  // ---- Stage 6 gate: 3 confessions + 3 jokes alternating
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

  // ---- Stage 7 gate: apology + forgiveness
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

  // Finally, route to stage engine
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
