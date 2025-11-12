// Chad — Moonlit Motel bot (FULL BUILD wired to provided brain.json)
// - Auto-clearing singleton lock (prevents double-posts)
// - Normalizes @mentions into "chad, ..." so stage triggers match
// - Weather/time + helpers
// - Justice/basement Q&A
// - Lore Q&A ("what is wrong with the motel", "who is soupy", etc.)
// - Easter eggs with {{template}} support (paths, [idx], and |join)
// - Mystery engine gates (3/6/7/9/10) using your brain.json triggers/hints
// - Catch-all so "chad ..." always gets a reply

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

// ---------- CONFIG ----------
const TZ  = process.env.TIMEZONE || 'America/Winnipeg';
const OWM = process.env.OPENWEATHER_API_KEY || null;

const STATE_DIR  = fs.existsSync('/data') ? '/data' : path.resolve('./');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

// ---------- SINGLETON LOCK (auto-clears; optional env tuning) ----------
const LOCK_PATH = path.join(STATE_DIR, 'chad.lock');
const MAX_LOCK_AGE_MS = (process.env.CHAD_LOCK_MAX_AGE_MINUTES
  ? Number(process.env.CHAD_LOCK_MAX_AGE_MINUTES) : 10) * 60 * 1000;

if (process.env.CHAD_LOCK_BUST === '1') { try { fs.rmSync(LOCK_PATH, { force: true }); } catch {} }

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
  fs.writeFileSync(_lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
} catch {
  console.error('🚫 Another Chad instance is already running. Exiting to avoid double posts.');
  process.exit(0);
}
function releaseLockAndExit(code=0){try{if(_lockFd!==null)fs.closeSync(_lockFd);}catch{} try{fs.unlinkSync(LOCK_PATH);}catch{} process.exit(code);}
['SIGINT','SIGTERM','SIGQUIT'].forEach(sig=>process.on(sig,()=>releaseLockAndExit(0)));
process.on('uncaughtException',err=>{console.error(err);releaseLockAndExit(1);});
process.on('unhandledRejection',err=>{console.error(err);releaseLockAndExit(1);});
process.on('exit',()=>{try{fs.unlinkSync(LOCK_PATH);}catch{};});

// ---------- FILE HELPERS ----------
const loadJSON = (p, fallback = {}) => { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return fallback; } };
const saveJSON = (p, obj) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };

// ---------- DATA ----------
let brain = loadJSON('./brain.json', {
  roast_pool:["default roast"],
  fortunes:["default fortune"],
  ambient:["ambient line"],
  facts_pool:["default fact"],
  guides:{}, lore:{}, stages:[]
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
  console.log(`Stages: ${(brain.stages||[]).length} | Ambient: ${(brain.ambient||[]).length} | Roasts: ${(brain.roast_pool||[]).length}`);
  console.log(`OpenWeather key present: ${!!OWM}`);

  // Ambient chatter every ~3h, 35% chance/guild
  setInterval(async () => {
    if (!brain.ambient?.length) return;
    for (const [gid] of client.guilds.cache) {
      const g = client.guilds.cache.get(gid);
      if (!g) continue;
      const chan = g.systemChannel || g.channels.cache.find(c => c?.isTextBased?.() && c.viewable);
      if (chan && Math.random() < 0.35) await chan.send(pick(brain.ambient)).catch(()=>{});
    }
  }, 1000*60*60*3);
});

// ---------- UTILS ----------
const pick = (arr=[]) => arr[Math.floor(Math.random()*arr.length)];
const getGuildState = (guildId) => (state[guildId] ||= { stage:1, gates:{}, cooldowns:{}, participants:{}, hintProg:{} });

const hasDailyCooldown = (gState, key) => gState.cooldowns[key] === DateTime.now().setZone(TZ).toISODate();
const setDailyCooldown = (gState, key) => { gState.cooldowns[key] = DateTime.now().setZone(TZ).toISODate(); saveJSON(STATE_PATH, state); };

const nowInWindow = (sh, sm, eh, em) => {
  const now = DateTime.now().setZone(TZ);
  const start = now.set({hour:sh, minute:sm, second:0, millisecond:0});
  const end   = now.set({hour:eh, minute:em, second:0, millisecond:0});
  return now >= start && now <= end;
};

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

// --- Small template renderer for easter_eggs ---
// Supports: {{a.b.c}}, {{arr[0]}}, {{lore.founders|join}}  (join with ", " by default)
function tmplResolve(pathExpr, obj) {
  // arr[2] support
  const parts = pathExpr.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) {
    if (p === '') continue;
    if (cur == null) return '';
    cur = cur[p];
  }
  return cur ?? '';
}
function renderTemplate(str, data) {
  return String(str).replace(/\{\{\s*([^}|]+)\s*(?:\|\s*(\w+))?\s*\}\}/g, (_, pathExpr, filter) => {
    let val = tmplResolve(pathExpr.trim(), data);
    if (filter === 'join' && Array.isArray(val)) return val.join(', ');
    if (typeof val === 'object') return JSON.stringify(val);
    return `${val}`;
  });
}

// ---------- WEATHER/TIME ----------
const US_STATES = {alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",connecticut:"CT",delaware:"DE","district of columbia":"DC",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA","west virginia":"WV",wisconsin:"WI",wyoming:"WY"};
const CA_PROV  = {alberta:"AB","british columbia":"BC",manitoba:"MB","new brunswick":"NB","newfoundland and labrador":"NL","nova scotia":"NS",ontario:"ON","prince edward island":"PE",quebec:"QC",saskatchewan:"SK","northwest territories":"NT",nunavut:"NU",yukon:"YT"};
function normalizeCityQuery(qRaw) {
  const q = (qRaw || "").trim();
  if (!q) return "Brandon,MB,CA";
  if (/[A-Za-z].*,\s*[A-Za-z]{2}\s*,\s*[A-Za-z]{2}/.test(q)) return q;
  const m = q.match(/^(.+?)[,\s]+([A-Za-z .'-]+)$/);
  if (m) {
    const city = m[1].trim();
    const region = m[2].trim().toLowerCase();
    if (US_STATES[region]) return `${city},${US_STATES[region]},US`;
    if (CA_PROV[region])   return `${city},${CA_PROV[region]},CA`;
  }
  return q;
}
function formatTime(zone) {
  const now = DateTime.now().setZone(zone || TZ);
  const nice = now.toFormat("ccc, LLL d 'at' h:mm a");
  return `🕰️ ${nice} (${zone})`;
}
async function fetchWeather(qRaw) {
  if (!OWM) return { err:"Weather not set up. Ask the Innkeeper to add OPENWEATHER_API_KEY." };
  const original = (qRaw || '').trim();
  const qNorm = normalizeCityQuery(original);

  // 1) name
  let r = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(qNorm)}&appid=${OWM}&units=metric`);
  if (!r.ok) {
    // 2) geocode
    const gr = await fetch(`https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(qNorm)}&limit=1&appid=${OWM}`);
    if (gr.ok) {
      const g = await gr.json();
      if (Array.isArray(g) && g.length) {
        const { lat, lon, name, state: st, country } = g[0];
        r = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM}&units=metric`);
        if (r.ok) {
          const d = await r.json();
          const desc = d.weather?.[0]?.description || 'weather';
          const t = Math.round(d.main?.temp ?? 0);
          const f = Math.round(d.main?.feels_like ?? t);
          const h = Math.round(d.main?.humidity ?? 0);
          const w = Math.round((d.wind?.speed ?? 0)*3.6);
          const label = `${name || d.name || qNorm}${st ? ', '+st : ''}${country ? ', '+country : ''}`;
          return { text:`🌤️ ${label}: ${desc}, ${t}°C (feels ${f}°C), humidity ${h}%, wind ${w} km/h` };
        }
      }
    }
    return { err:`couldn't fetch weather for "${original || qNorm}".` };
  }
  const d = await r.json();
  const desc = d.weather?.[0]?.description || 'weather';
  const t = Math.round(d.main?.temp ?? 0);
  const f = Math.round(d.main?.feels_like ?? t);
  const h = Math.round(d.main?.humidity ?? 0);
  const w = Math.round((d.wind?.speed ?? 0)*3.6);
  return { text:`🌤️ ${d.name || qNorm}: ${desc}, ${t}°C (feels ${f}°C), humidity ${h}%, wind ${w} km/h` };
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
  if (!role) role = await guild.roles.create({ name:'Keyholder', color:0xff66cc, reason:'Mystery reward role' });
  return role;
}
async function ensureArchiveChannel(guild, role) {
  let chan = guild.channels.cache.find(c => c.name === 'archive-of-truth');
  if (!chan) {
    chan = await guild.channels.create({
      name:'archive-of-truth',
      reason:'Mystery finale secret room',
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
    ? remaining[Math.floor(Math.random()*remaining.length)]
    : Math.floor(Math.random()*pool.length);

  if (!remaining.length) prog.used = []; // reset next cycle
  prog.used.push(pickIdx);
  gState.hintProg[skey] = prog;
  saveJSON(STATE_PATH, state);
  return pool[pickIdx];
}
async function maybeHint(message, gState, stageObj, contentNorm) {
  if (!stageObj.hints?.length) return;
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

  const summary = "The Motel’s “justice system” is a playful, opt-in bit. **Not** for real conflicts. Mods can override anything.";
  const nominations = `**Nominations:** Post in **${jailNom}** (or ping ${dmName}) with a short reason and SFW/NSFW choice.`;
  const court = `**Court flow:** ${dmName} curates top 3 silly sentences and opens a poll in **${courtCh}**. Community votes.`;
  const sentence = `**Sentencing:** Chill in **${sfwJail}** or **${nsfwJail}** ~10m. Complete the task → free. Low effort → “Role of Shame” (~24h).`;
  const serious = `**Serious stuff:** Harassment, slurs, threats, doxxing, self-harm, etc. go to mods directly (/report).`;
  const forums = `**Forums:** Long debates live in Forums. Posting is **${ffName}+** to avoid drive-by weird ideology. Guests can read.`;
  const consent = `**Consent:** DM a mod to opt-out of nominations—always respected.`;

  return ["🏛️ **Moonlit Motel — Justice System**", summary, "", nominations, court, sentence, serious, forums, consent].join("\n");
}

// ---------- MOTEL STATUS / SOUPY HELPERS ----------
function buildMotelStatus(gState) {
  const ov = brain?.lore_overview || [
    "The hall lights hum in the wrong key.",
    "Keys breed in the drawer; none fit the same door twice.",
    "Exit signs point inward.",
    "The ledger writes names we don’t remember checking in.",
    "There’s a room with more corners than walls."
  ];
  const tip = brain?.lore_tip || "Ask: `chad, hint` or try the **ledger**, **mirror**, or the **light**.";
  const stage = gState?.stage ?? 1;
  return ["🛎️ **What’s wrong with the Motel?**", `• **Current stage:** ${stage}`, `• **Observation:** ${pick(ov)}`, `• **Tip:** ${tip}`].join("\n");
}
function buildSoupyLore() {
  const lines = brain?.lore?.characters?.soupy?.answers || [
    "🍲 **Soupy** was the first guest to fix the vending machine; now it hums their name.",
    "If you smell tomato basil at 3AM, don’t open the fridge. That’s Soupy passing through.",
    "Soupy is half rumor, half maintenance spirit, wholly nosy."
  ];
  return `**Who is Soupy?**\n${pick(lines)}`;
}

// ---------- MYSTERY ENGINE ----------
async function handleMystery(message, contentNorm) {
  const gState = getGuildState(message.guild.id);
  const stageObj = (brain.stages || []).find(s => s.number === gState.stage);
  if (!stageObj) return;

  // IMPORTANT: test triggers against normalized content (so "chad, ..." variants match)
  const triggered = (stageObj.triggers || []).some(rx => new RegExp(rx, 'i').test(contentNorm));
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

// ---------- MESSAGE HANDLER ----------
const CHAD_FALLBACKS = [
  "look at the glow, not the walls.",
  "light forgets moments, not people. think like a poet.",
  "ask me for **weather**, **time**, a **hint**, or **what’s wrong with the motel**.",
  "the basement? sunday runs it. obviously.",
  "tell me a secret and i’ll give you a door."
];

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  // Normalize content (turn mentions into "chad, ...")
  const content = normalizeWake(message.content || '', client);
  const gState = getGuildState(message.guild.id);
  gState.participants[message.author.id] = true;

  // Roast homage (daily)
  await maybeRoast(message, gState);

  // --- Fortunes ---
  if (/^chad[, ]\s*ask the motel\b/i.test(content)) {
    const pool = brain.fortunes || [];
    if (pool.length) { await message.reply(pick(pool)).catch(()=>{}); return; }
  }

  // --- Random fact ---
  if (/^chad[, ]\s*(random\s+fact|fact)[.?!]*$/i.test(content)) {
    await message.reply(`📎 ${pick(brain.facts_pool || ["default fact"])}`).catch(()=>{});
    return;
  }

  // --- Time ---
  const timeMatch =
    content.match(/^chad[, ]\s*time(?:\s+in\s+(.+?))?[.?!]*$/i) ||
    content.match(/^chad[, ]\s*what(?:'s| is)?\s+(?:the\s+)?time(?:\s+in\s+(.+?))?[.?!]*$/i) ||
    content.match(/^chad[, ]\s*what\s+time\s+is\s+it(?:\s+in\s+(.+?))?[.?!]*$/i);
  if (timeMatch) {
    const place = timeMatch[1] || timeMatch[2] || timeMatch[3];
    const zone = (() => {
      const s = (place||'').toLowerCase().trim();
      if (!s) return TZ;
      if (/(brandon|manitoba|winnipeg|mb|prairies)/i.test(s)) return 'America/Winnipeg';
      if (/new york|nyc|eastern/i.test(s)) return 'America/New_York';
      if (/la|los angeles|pacific|pst|pdt/i.test(s)) return 'America/Los_Angeles';
      if (/london|uk|gmt|britain/i.test(s)) return 'Europe/London';
      return TZ;
    })();
    await message.reply(formatTime(zone)).catch(()=>{});
    return;
  }

  // --- Weather ---
  const wMatch =
    content.match(/^chad[, ]\s*weather(?:\s+in\s+(.+?))?[.?!]*$/i) ||
    content.match(/^chad[, ]\s*what(?:'s| is)\s+(?:the\s+)?weather(?:\s+in\s+(.+?))?[.?!]*$/i);
  if (wMatch) {
    const city = (wMatch[1] || wMatch[2] || '').trim();
    const res = await fetchWeather(city);
    await message.reply(res.err ? `⚠️ ${res.err}` : res.text).catch(()=>{});
    return;
  }

  // --- Basement / NSFW helper (+ cheeky "who runs" replies) ---
  if (/^chad[, ]\s*(what\s+is|where\s+is|tell\s+me\s+about|who\s+runs)\s+the\s+basement\??[.?!]*$/i.test(content)) {
    const sfw  = brain?.guides?.channels?.sfw_jail  || "🔒the-broom-closet🧹";
    const nsfw = brain?.guides?.channels?.nsfw_jail || "🤫the-no-tell-motel-room💣";
    const dm   = brain?.guides?.dungeon_master || "Sunday";
    if (/who\s+runs/i.test(content)) {
      const responses = [
        `👑 ${dm} rules the Basement with equal parts menace and glitter.`,
        `it’s run by **${dm}**. consent is the safeword.`,
        `${dm} runs it. fog machine sold separately.`,
        `that’d be ${dm}. the keys jingle ominously.`,
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

  // --- Justice system explainer ---
  if (
    /^chad[, ]\s*(explain|what\s+is|tell\s+me\s+about)\s+(the\s+)?(justice\s+system|court|court\s+system|motel\s+court|jail|jail\s+process)\b.*$/i.test(content) ||
    /^chad[, ]\s*how\s+(does|do)\s+(the\s+)?(court|justice\s+system)\s+work\??[.?!]*$/i.test(content) ||
    /^chad[, ]\s*how\s+are\s+people\s+nominated\??[.?!]*$/i.test(content)
  ) {
    await message.reply(buildJusticeExplainer()).catch(()=>{});
    return;
  }

  // --- Lore Q&A you asked for ---
  if (/^chad[\s,]+\s*what\s+is\s+wrong\s+with\s+the\s+motel\??$/i.test(content)) {
    await message.reply(buildMotelStatus(gState)).catch(()=>{});
    return;
  }
  if (/^chad[\s,]+\s*(who\s+is|tell\s+me\s+about)\s+soupy\??$/i.test(content)) {
    await message.reply(buildSoupyLore()).catch(()=>{});
    return;
  }
  if (/^chad[\s,]+\s*what\s+are\s+you\??$/i.test(content)) {
    await message.reply("i’m the wiring between your jokes and your goosebumps. also: a discord bot.").catch(()=>{});
    return;
  }
  if (/^chad[\s,]+\s*what\s+is\s+the\s+point\s+of\s+the\s+motel\??$/i.test(content)) {
    const lines = brain?.lore?.motel_point || [
      "to make room for heavy hearts and light nonsense at the same time.",
      "to practice consent, comedy, and community without paperwork.",
      "to be a place where secrets unlock doors instead of locking them."
    ];
    await message.reply(pick(lines)).catch(()=>{});
    return;
  }
  if (/^chad[\s,]+\s*tell\s+me\s+something\??$/i.test(content)) {
    const pool = [
      ...(brain?.facts_pool || []),
      ...(brain?.ambient || []),
      "mirrors answer questions you already asked.",
      "some keys only turn when you forgive yourself."
    ];
    await message.reply(`📎 ${pick(pool)}`).catch(()=>{});
    return;
  }

  // --- Easter eggs with template rendering from brain.json ---
  for (const egg of (brain.easter_eggs || [])) {
    try {
      const re = new RegExp(egg.trigger_regex, 'i');
      if (re.test(content)) {
        if (egg.responses_key && brain[egg.responses_key]) {
          await message.reply(pick(brain[egg.responses_key])).catch(()=>{});
        } else if (egg.responses?.length) {
          const rendered = egg.responses.map(s => renderTemplate(s, brain));
          await message.reply(pick(rendered)).catch(()=>{});
        } else if (typeof egg.responses === 'string') {
          await message.reply(renderTemplate(egg.responses, brain)).catch(()=>{});
        }
        return;
      }
    } catch {/* ignore malformed egg */}
  }

  // --- Manual hint ---
  if (/^chad[, ]\s*hint$/i.test(content)) {
    const stageObj = (brain.stages || []).find(s => s.number === gState.stage);
    if (!stageObj?.hints?.length) { await message.reply("no hints for this part. try the **ledger**, the **mirror**, or the **light**.").catch(()=>{}); return; }
    const key = `hint_${gState.stage}`;
    if (hasDailyCooldown(gState, key)) { await message.reply("you already got a hint today. try something reckless instead.").catch(()=>{}); return; }
    const hint = nextUniqueHint(gState, stageObj) || pick(stageObj.hints);
    await message.reply(hint).catch(()=>{});
    setDailyCooldown(gState, key);
    return;
  }

  // --- Quick debug of stage/gates ---
  if (/^chad[, ]\s*debug\s+stage$/i.test(content)) {
    const stageObj = (brain.stages || []).find(s => s.number === gState.stage) || {};
    const info = { stage:gState.stage, gates:Object.keys(gState.gates||{}), hintsLoaded:(stageObj.hints||[]).length, triggersLoaded:(stageObj.triggers||[]).length };
    await message.reply("```json\n"+JSON.stringify(info,null,2)+"\n```").catch(()=>{});
    return;
  }

  // 2) Route to mystery BEFORE catch-all so triggers fire
  await handleMystery(message, content);

  // 3) Catch-alls so Chad always answers when addressed
  if (/,chad\b/i.test(message.content)) { // anywhere: ",chad"
    const pool = brain?.fallbacks?.length ? brain.fallbacks : CHAD_FALLBACKS;
    await message.reply(pick(pool)).catch(()=>{});
    return;
  }
  if (/^chad\b/i.test(content)) { // starts with "chad"
    const pool = brain?.fallbacks?.length ? brain.fallbacks : CHAD_FALLBACKS;
    await message.reply(pick(pool)).catch(()=>{});
    return;
  }
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
