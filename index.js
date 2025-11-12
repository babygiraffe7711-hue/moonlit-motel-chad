// Chad — Moonlit Motel bot (all-in-one)
// - Mystery engine hooks + hints
// - Weather + worldwide time
// - Basement/Dungeon + Justice explainer
// - Roles overview
// - Teach/forget custom replies
// - Ambient chatter + roast homage
// - AI fallback w/ tool calls (no need to hard-code every simple Q)
// ---------------------------------------------------------------

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import OpenAI from 'openai';

// ---------- CONFIG ----------
const TZ  = process.env.TIMEZONE || 'America/Winnipeg';
const OWM = process.env.OPENWEATHER_API_KEY || null;

// Where state files live (Render disk if present)
const STATE_DIR  = fs.existsSync('/data') ? '/data' : path.resolve('./');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const DYN_INTENTS_PATH = path.join(STATE_DIR, 'brain_dynamic.json');

// ---------- SINGLETON LOCK (avoid double posts on Render) ----------
const LOCK_PATH = path.join(STATE_DIR, 'chad.lock');
const MAX_LOCK_AGE_MS = (process.env.CHAD_LOCK_MAX_AGE_MINUTES ? Number(process.env.CHAD_LOCK_MAX_AGE_MINUTES) : 10) * 60 * 1000;
if (process.env.CHAD_LOCK_BUST === '1') { try { fs.rmSync(LOCK_PATH, { force: true }); } catch {} }
try {
  const st = fs.statSync(LOCK_PATH);
  if (Date.now() - st.mtimeMs > MAX_LOCK_AGE_MS) { fs.rmSync(LOCK_PATH, { force: true }); }
} catch {}
let _lockFd = null;
try {
  _lockFd = fs.openSync(LOCK_PATH, 'wx');
  fs.writeFileSync(_lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
} catch {
  console.error('🚫 Another Chad instance is already running. Exiting to avoid double posts.');
  process.exit(0);
}
function releaseLockAndExit(code=0){ try{ if(_lockFd!==null) fs.closeSync(_lockFd);}catch{} try{fs.unlinkSync(LOCK_PATH);}catch{} process.exit(code); }
['SIGINT','SIGTERM','SIGQUIT'].forEach(sig=>process.on(sig,()=>releaseLockAndExit(0)));
process.on('uncaughtException',e=>{ console.error(e); releaseLockAndExit(1); });
process.on('unhandledRejection',e=>{ console.error(e); releaseLockAndExit(1); });
process.on('exit',()=>{ try{fs.unlinkSync(LOCK_PATH);}catch{} });

// ---------- FILE HELPERS ----------
const loadJSON = (p, fallback = {}) => { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return fallback; } };
const saveJSON = (p, obj) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };

// ---------- DATA ----------
let brain = loadJSON('./brain.json', { roast_pool:["default roast"], fortunes:["default fortune"], ambient:["ambient"], facts_pool:["default fact"], guides:{}, lore:{}, stages:[] });
let state = loadJSON(STATE_PATH, {}); // guildId -> { stage, gates, cooldowns, participants, hintProg }
let dynamicIntents = loadJSON(DYN_INTENTS_PATH, { intents: [] });

// ---------- DISCORD CLIENT ----------
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
  console.log(`OpenWeather: ${!!OWM} | Timezone: ${TZ}`);
  console.log('DISCORD_TOKEN present:', !!(process.env.DISCORD_TOKEN||'').trim());
  console.log('OPENWEATHER_API_KEY present:', !!(process.env.OPENWEATHER_API_KEY||'').trim());
  console.log(`OpenAI: ${!!OPENAI_KEY} | Model: ${AI_MODEL}`);
  if (!OPENAI_KEY) {
    console.warn('⚠️ OPENAI_API_KEY missing or blank. Chad will NOT use OpenAI.');
  }

  // Ambient: drop a random line every ~3 hours, per guild 35% chance
  setInterval(async () => {
    if (!brain.ambient?.length) return;
    for (const [gid] of client.guilds.cache) {
      const g = client.guilds.cache.get(gid);
      const chan = g?.systemChannel || g?.channels?.cache.find(c => c?.isTextBased?.() && c.viewable);
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

// Template renderer for easter_eggs: {{a.b}} and {{arr|join}}
function tmplResolve(pathExpr, obj) {
  const parts = pathExpr.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) { if (p === '') continue; if (cur == null) return ''; cur = cur[p]; }
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

// Helpers for teach/learn
function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function toLooseChadPattern(phrase){
  let p = phrase.trim().replace(/^chad\s*,?\s*/i, '');
  p = escapeRe(p).replace(/\s+/g, '\\s+');
  p = `${p}(?:\\s*[?.!])?`;
  const P_CHAD = '^\\s*(?:chad|<@!?\\d+>)\\s*,?\\s*';
  return `${P_CHAD}${p}$`;
}
function pickPiped(reply){
  if (reply.includes('|')){
    const choices = reply.split('|').map(s=>s.trim()).filter(Boolean);
    if (choices.length) return choices[Math.floor(Math.random()*choices.length)];
  }
  return reply;
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
const TZ_MAP = {
  "winnipeg":"America/Winnipeg","manitoba":"America/Winnipeg","brandon":"America/Winnipeg",
  "new york":"America/New_York","nyc":"America/New_York","eastern":"America/New_York",
  "los angeles":"America/Los_Angeles","la":"America/Los_Angeles","pacific":"America/Los_Angeles",
  "london":"Europe/London","uk":"Europe/London","united kingdom":"Europe/London","england":"Europe/London","manchester":"Europe/London","scotland":"Europe/London","wales":"Europe/London",
  "seoul":"Asia/Seoul","south korea":"Asia/Seoul","republic of korea":"Asia/Seoul","korea (south)":"Asia/Seoul",
  "pyongyang":"Asia/Pyongyang","north korea":"Asia/Pyongyang","dprk":"Asia/Pyongyang",
  "sydney":"Australia/Sydney","australia":"Australia/Sydney",
  "toronto":"America/Toronto","montreal":"America/Toronto","vancouver":"America/Vancouver",
  "paris":"Europe/Paris","berlin":"Europe/Berlin","madrid":"Europe/Madrid",
  "tokyo":"Asia/Tokyo","japan":"Asia/Tokyo","beijing":"Asia/Shanghai","china":"Asia/Shanghai",
  "mexico city":"America/Mexico_City","mexico":"America/Mexico_City",
  "rio":"America/Sao_Paulo","brazil":"America/Sao_Paulo",
  "dubai":"Asia/Dubai","uae":"Asia/Dubai",
  "delhi":"Asia/Kolkata","india":"Asia/Kolkata",
  "cairo":"Africa/Cairo","egypt":"Africa/Cairo",
  "nairobi":"Africa/Nairobi","kenya":"Africa/Nairobi"
};
function tzAlias(place) {
  if (!place) return TZ;
  const s = place.toLowerCase().trim();
  if (TZ_MAP[s]) return TZ_MAP[s];
  const clean = s.replace(/\b(time|the|city)\b/g, '').replace(/[.,]/g,'').trim();
  if (TZ_MAP[clean]) return TZ_MAP[clean];
  const parts = clean.split(/\s+/);
  const last = parts[parts.length-1];
  if (TZ_MAP[last]) return TZ_MAP[last];
  return TZ;
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
  let r = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(qNorm)}&appid=${OWM}&units=metric`);
  if (!r.ok) {
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

// ---------- ROAST ----------
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

// ---------- HINT CYCLER ----------
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
  if (!remaining.length) prog.used = [];
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

// ---------- JUSTICE + ROLES BUILDERS ----------
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
function buildRolesOverview() {
  const r = brain?.guides?.roles || {};
  const lines = [];
  const add = (name, desc) => lines.push(`• **${name}** — ${desc}`);
  add(r.guest_name || "Guest", r.guest_desc || "default entry role; read most channels, chill.");
  add(r.frequent_flyer || "Frequent Flyer", r.frequent_flyer_desc || "trusted regulars; can post in Forums.");
  add(r.dungeon_dweller || "Dungeon Dweller", r.dungeon_dweller_desc || "NSFW access; votes on new entrants.");
  add(r.keyholder || "Keyholder", r.keyholder_desc || "mystery contributors; access to Archive of Truth.");
  add(r.jailed_sfw || "Jailed (SFW)", r.jailed_sfw_desc || "temporary SFW time-out room.");
  add(r.jailed_nsfw || "Jailed (NSFW)", r.jailed_nsfw_desc || "temporary NSFW dungeon time-out.");
  add(r.staff || "Staff/Mods", r.staff_desc || "keep the lights steady & exits honest.");
  return "🧾 **Server Roles Overview**\n" + lines.join("\n");
}
function buildMotelStatus(gState) {
  const ov = brain?.lore_overview || [
    "The hall lights hum in the wrong key.",
    "Keys breed in the drawer; none fit the same door twice.",
    "Exit signs point inward.",
    "The ledger writes names we don’t remember checking in."
  ];
  const tip = brain?.lore_tip || "Try the **mirror**, the **light**, or the **ledger**. Or say `chad, hint`.";
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

// ---------- AI FALLBACK ----------
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;
const AI_MODEL = (process.env.CHAD_AI_MODEL || 'gpt-4o-mini').trim();
const SYSTEM_CHAD = `
You are "Chad", the Moonlit Motel desk clerk: witty, kind, a little feral.
Be concise and helpful. Stay in-universe but use tools for facts (time/weather/justice/basement/roles).
Never invent server rules; call tools I give you.
If a question is clearly "mystery progression", say: "try the mirror, the light, or the ledger."
`;
const toolDefs = [
  { type:"function", name:"tool_time", description:"Return local time for a place", parameters:{ type:"object", properties:{ place:{type:"string"} }, required:["place"] } },
  { type:"function", name:"tool_weather", description:"Return current weather for a place", parameters:{ type:"object", properties:{ place:{type:"string"} }, required:["place"] } },
  { type:"function", name:"tool_basement", description:"Explain Basement/NSFW and who runs it", parameters:{ type:"object", properties:{}, required:[] } },
  { type:"function", name:"tool_justice", description:"Explain Motel justice/court system", parameters:{ type:"object", properties:{}, required:[] } },
  { type:"function", name:"tool_roles", description:"Explain server roles", parameters:{ type:"object", properties:{}, required:[] } }
];
async function tool_time(args){ return formatTime(tzAlias(args.place)); }
async function tool_weather(args){ const res = await fetchWeather(args.place || ""); return res.err ? `⚠️ ${res.err}` : res.text; }
async function tool_basement(){
  const sfw  = brain?.guides?.channels?.sfw_jail  || "🔒the-broom-closet🧹";
  const nsfw = brain?.guides?.channels?.nsfw_jail || "🤫the-no-tell-motel-room💣";
  const dm   = brain?.guides?.dungeon_master || "Sunday";
  const access = brain?.guides?.dungeon_access || "you need a nomination from a Dweller; then the Dungeon votes.";
  return `the Basement is our NSFW wing, run by **${dm}**. ${access}
SFW jail: **${sfw}** • NSFW jail: **${nsfw}**`;
}
async function tool_justice(){ return buildJusticeExplainer(); }
async function tool_roles(){ return buildRolesOverview(); }
async function aiAnswer(userText){
  // Allow AI even if lore words appear; mystery is handled earlier.
  if (!openai) return null;
  const messages = [{ role:"system", content:SYSTEM_CHAD }, { role:"user", content:userText }];
  const resp = await openai.chat.completions.create({ model:AI_MODEL, messages, tools:toolDefs, tool_choice:"auto", temperature:0.7 });
  const msg = resp.choices[0].message;
  if (msg.tool_calls?.length) {
    const call = msg.tool_calls[0];
    const name = call.function.name;
    const args = JSON.parse(call.function.arguments || "{}");
    let toolResult = "";
    try {
      if (name === "tool_time")     toolResult = await tool_time(args);
      if (name === "tool_weather")  toolResult = await tool_weather(args);
      if (name === "tool_basement") toolResult = await tool_basement();
      if (name === "tool_justice")  toolResult = await tool_justice();
      if (name === "tool_roles")    toolResult = await tool_roles();
    } catch { toolResult = "⚠️ tool failed."; }
    const follow = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role:"system", content:SYSTEM_CHAD },
        { role:"user", content:userText },
        msg,
        { role:"tool", name, content: toolResult }
      ],
      temperature: 0.7
    });
    return follow.choices[0].message.content?.trim() || toolResult;
  }
  return msg.content?.trim() || null;
}

// ---------- INTENTS ----------
const R = (s) => new RegExp(s, 'i');
const P_CHAD = '^\\s*(?:chad|<@!?\\d+>)\\s*,?\\s*';
const BUILTIN_INTENTS = [
  { name:'MOTEL_STATUS', patterns:[ R(`${P_CHAD}(?:what(?:'s|s|\\s+is)\\s+)?wrong\\s+with\\s+the\\s+motel\\s*\\??$`) ], handler: async (m,g)=>{ await m.reply(buildMotelStatus(g)).catch(()=>{}); } },
  { name:'SOUKY', patterns:[ R(`${P_CHAD}(?:who\\s+is|tell\\s+me\\s+about)\\s+soupy\\s*\\??$`) ], handler: async (m)=>{ await m.reply(buildSoupyLore()).catch(()=>{}); } },
  { name:'WHAT_ARE_YOU', patterns:[ R(`${P_CHAD}what\\s+are\\s+you\\s*\\??$`) ], handler: async (m)=>{ await m.reply("i’m the wiring between your jokes and your goosebumps. also: a discord bot.").catch(()=>{}); } },
  { name:'MOTEL_POINT', patterns:[ R(`${P_CHAD}what\\s+is\\s+the\\s+point\\s+of\\s+the\\s+motel\\s*\\??$`), R(`${P_CHAD}why\\s+does\\s+the\\s+motel\\s+exist\\s*\\??$`) ], handler: async (m)=>{ const lines = brain?.lore?.motel_point || ["to make room for heavy hearts and light nonsense at the same time.","to practice consent, comedy, and community without paperwork.","to be a place where secrets unlock doors instead of locking them."]; await m.reply(pick(lines)).catch(()=>{}); } },
  { name:'ROLES_LIST', patterns:[ R(`${P_CHAD}(?:what\\s+roles\\s+exist|what\\s+are\\s+the\\s+roles|list\\s+roles|roles\\s+overview|explain\\s+the\\s+roles)\\b.*$`) ], handler: async (m)=>{ await m.reply(buildRolesOverview()).catch(()=>{}); } },
  { name:'DATE_ME_SARCASM', patterns:[ R(`${P_CHAD}(?:would\\s+you\\s+date\\s+me|date\\s+me)\\??$`) ], handler: async (m)=>{ const z = ["romantically? no. professionally? also no.","my type is ‘plug-and-play neon signage’. you’re very… carbon-based.","we can hold hands at 3:03 and panic together. that’s the most i can offer.","i’m emotionally unavailable and physically a bot. rain check forever."]; await m.reply(pick(z)).catch(()=>{}); } }
];
async function routeIntent(message, contentNorm, gState) {
  for (const intent of BUILTIN_INTENTS) {
    if (intent.patterns.some(rx => rx.test(contentNorm))) { await intent.handler(message, gState); return true; }
  }
  for (const it of (dynamicIntents.intents || [])) {
    try {
      const rx = new RegExp(it.pattern, 'i');
      if (rx.test(contentNorm)) { await message.reply(renderTemplate(pickPiped(it.reply), brain)).catch(()=>{}); return true; }
    } catch {}
  }
  return false;
}

// ---------- MYSTERY ----------
async function handleMystery(message, contentNorm) {
  const gState = getGuildState(message.guild.id);
  const stageObj = (brain.stages || []).find(s => s.number === gState.stage);
  if (!stageObj) return;
  const triggered = (stageObj.triggers || []).some(rx => new RegExp(rx, 'i').test(contentNorm));
  if (!triggered) { await maybeHint(message, gState, stageObj, contentNorm); return; }
  if (stageObj.timeWindow) {
    const [sh, sm, eh, em] = stageObj.timeWindow;
    if (!nowInWindow(sh, sm, eh, em)) { await message.reply(stageObj.timeLockedReply || "too early. so ambitious. so wrong.").catch(()=>{}); return; }
  }
  switch (gState.stage) {
    case 3: { await message.channel.send(stageObj.response).catch(()=>{}); if (stageObj.taskPrompt) await message.channel.send(stageObj.taskPrompt).catch(()=>{}); gState.gates.s3 = gState.gates.s3 || { confessors: {} }; break; }
    case 6: { await message.channel.send(stageObj.response).catch(()=>{}); if (stageObj.taskPrompt) await message.channel.send(stageObj.taskPrompt).catch(()=>{}); gState.gates.s6 = { sequence: [], done: false }; break; }
    case 7: { await message.channel.send(stageObj.response).catch(()=>{}); if (stageObj.taskPrompt) await message.channel.send(stageObj.taskPrompt).catch(()=>{}); gState.gates.s7 = { apologyBy: null, forgivenessBy: null }; break; }
    case 9: { const pollMsg = await message.channel.send(stageObj.response).catch(()=>null); if (pollMsg){ await pollMsg.react('✅').catch(()=>{}); await pollMsg.react('❌').catch(()=>{});} gState.gates.s9 = { pollId: pollMsg?.id || null, closed: false }; saveJSON(STATE_PATH, state); return; }
    case 10:{ await message.channel.send(stageObj.response).catch(()=>{}); const role = await ensureKeyholderRole(message.guild); const chan = await ensureArchiveChannel(message.guild, role); const contributors = Object.keys(gState.participants || {}); for (const uid of contributors){ const member = await message.guild.members.fetch(uid).catch(()=>null); if (member && !member.roles.cache.has(role.id)) await member.roles.add(role).catch(()=>{}); } await chan.send(brain.finaleRoomWelcome || "Welcome, Keyholders.").catch(()=>{}); break; }
    default:{ await message.channel.send(stageObj.response).catch(()=>{}); }
  }
  if (!stageObj.requiresGate) { gState.stage++; saveJSON(STATE_PATH, state); } else saveJSON(STATE_PATH, state);
}

// ---------- MESSAGE HANDLER ----------
const CHAD_FALLBACKS = [
  "look at the glow, not the walls.",
  "light forgets moments, not people. think like a poet.",
  "ask me for **weather**, **time**, a **hint**, or **what’s wrong with the motel**.",
  "tell me a secret and i’ll give you a door."
];

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const gState = getGuildState(message.guild.id);
  gState.participants[message.author.id] = true;

  const content = normalizeWake(message.content || '', client);

  // Roast homage (daily cooldown)
  await maybeRoast(message, gState);

  // Fortunes
  if (/^chad[, ]\s*ask the motel\b/i.test(content)) {
    const pool = brain.fortunes || [];
    if (pool.length) { await message.reply(pick(pool)).catch(()=>{}); return; }
  }

  // Random fact
  if (/^chad[, ]\s*(random\s+fact|fact)[.?!]*$/i.test(content)) {
    await message.reply(`📎 ${pick(brain.facts_pool || ["default fact"])}`).catch(()=>{});
    return;
  }

  // TIME (tolerant)
  const timeRegexes = [
    /^chad[, ]\s*time(?:\s+in\s+(.+))?[.?!]*$/i,
    /^chad[, ]\s*what(?:'s| is)?\s+(?:the\s+)?time(?:\s+in\s+(.+))?[.?!]*$/i,
    /^chad[, ]\s*what\s+time\s+is\s+it(?:\s+in\s+(.+))?[.?!]*$/i,
    /^chad[, ]\s*tell\s+me\s+the\s+time(?:\s+in\s+(.+))?[.?!]*$/i,
    /^chad[, ]\s*time\s+([A-Za-z ,'-]+)[.?!]*$/i
  ];
  let placeStr = null;
  for (const rx of timeRegexes) { const m = content.match(rx); if (m) { placeStr = (m[1] || '').trim(); break; } }
  if (placeStr !== null) { await message.reply(formatTime(tzAlias(placeStr))).catch(()=>{}); return; }

  // WEATHER
  const wMatch =
    content.match(/^chad[, ]\s*weather(?:\s+in\s+(.+?))?[.?!]*$/i) ||
    content.match(/^chad[, ]\s*what(?:'s| is)\s+(?:the\s+)?weather(?:\s+in\s+(.+?))?[.?!]*$/i);
  if (wMatch) {
    const city = (wMatch[1] || wMatch[2] || '').trim();
    const res = await fetchWeather(city);
    await message.reply(res.err ? `⚠️ ${res.err}` : res.text).catch(()=>{});
    return;
  }

  // BASEMENT / DUNGEON (who/explain/where/etc.)
  if (/^chad[, ]\s*(what\s+is|where\s+is|tell\s+me\s+about|explain|describe|how\s+does|how\s+do|what\s+does.*mean)\s+(the\s+)?(basement|dungeon)\b.*$/i.test(content)
   || /^chad[, ]\s*(who\s+runs|who\s+is|who's|who\s+is\s+in\s+charge|who\s+leads|who\s+owns|who\s+controls|who\s+manages|who\s+the\s+dungeon\s+master\s+is)\s+(the\s+)?(basement|dungeon|dungeon\s+master)\??[.?!]*$/i.test(content)) {
    const sfw  = brain?.guides?.channels?.sfw_jail  || "🔒the-broom-closet🧹";
    const nsfw = brain?.guides?.channels?.nsfw_jail || "🤫the-no-tell-motel-room💣";
    const dm   = brain?.guides?.dungeon_master || "Sunday";
    const access = brain?.guides?.dungeon_access || "you need a nomination from a Dweller; then the Dungeon votes.";
    if (/who\s/.test(content) || /dungeon\s+master/i.test(content)) {
      const responses = [
        `👑 ${dm} runs the Basement, the Dungeon, and probably your curiosity.`,
        `that would be **${dm}** — Keeper of Keys, Warden of Winks.`,
        `it’s run by **${dm}**. consent is the safeword.`,
        `the Dungeon Master? **${dm}**, obviously.`,
        `${dm}. fog machine sold separately.`,
        `that’d be ${dm}. the keys jingle ominously.`,
        `the Basement belongs to ${dm}. enter at your own peril—or delight.`
      ];
      await message.reply(pick(responses)).catch(()=>{});
    } else {
      await message.reply(`we call the NSFW wing **the Basement**. it’s run by **${dm}**.\n${access}\nSFW jail: **${sfw}** • NSFW jail: **${nsfw}**`).catch(()=>{});
    }
    return;
  }

  // JUSTICE EXPLAINER
  if (
    /^chad[, ]\s*(explain|what\s+is|tell\s+me\s+about)\s+(the\s+)?(justice\s+system|court|court\s+system|motel\s+court|jail|jail\s+process)\b.*$/i.test(content) ||
    /^chad[, ]\s*how\s+(does|do)\s+(the\s+)?(court|justice\s+system)\s+work\??[.?!]*$/i.test(content) ||
    /^chad[, ]\s*how\s+are\s+people\s+nominated\??[.?!]*$/i.test(content)
  ) { await message.reply(buildJusticeExplainer()).catch(()=>{}); return; }

  // TEACH / FORGET / LIST
  let mLearn = content.match(/^chad[, ]\s*learn:\s*when\s+i\s+say\s+"([\s\S]+?)"\s*reply\s+"([\s\S]+)"\s*$/i)
            || content.match(/^chad[, ]\s*learn:\s*"([\s\S]+?)"\s*->\s*"([\s\S]+)"\s*$/i);
  if (mLearn) {
    const rawPattern = mLearn[1].trim();
    const reply = mLearn[2].trim();
    const looksLikeRegex = /^\/[\s\S]+\/[imuxs]*$/.test(rawPattern);
    const storedPattern = looksLikeRegex ? rawPattern : toLooseChadPattern(rawPattern);
    dynamicIntents.intents.push({ pattern: storedPattern, reply });
    saveJSON(DYN_INTENTS_PATH, dynamicIntents);
    await message.reply(`✅ learned.\n• pattern: \`/${storedPattern}/i\`\n• reply: ${reply.substring(0,400)}`).catch(()=>{});
    return;
  }
  const mForget = content.match(/^chad[, ]\s*forget:\s*"(.+)"\s*$/i);
  if (mForget) {
    const pat = mForget[1].trim();
    const before = dynamicIntents.intents.length;
    dynamicIntents.intents = dynamicIntents.intents.filter(x => x.pattern !== pat);
    saveJSON(DYN_INTENTS_PATH, dynamicIntents);
    await message.reply(before === dynamicIntents.intents.length ? `⚠️ i didn’t know that one.` : `🗑️ forgotten: \`${pat}\``).catch(()=>{});
    return;
  }
  if (/^chad[, ]\s*list\s+lessons$/i.test(content)) {
    const list = dynamicIntents.intents.slice(0,12).map((x,i)=>`${i+1}. /${x.pattern}/ → ${x.reply.substring(0,80)}…`);
    await message.reply(list.length ? "📚 **learned intents:**\n" + list.join("\n") : "📚 i haven’t learned any custom intents yet.").catch(()=>{});
    return;
  }

  // ROUTE INTENTS (roles list, date-me sarcasm, motel status, etc.)
  const intentHit = await routeIntent(message, content, gState);
  if (intentHit) return;

  // EASTER EGGS from brain.json
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
    } catch {}
  }

  // Manual hint
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

  // Debug
  if (/^chad[, ]\s*debug\s+stage$/i.test(content)) {
    const stageObj = (brain.stages || []).find(s => s.number === gState.stage) || {};
    const info = { stage:gState.stage, gates:Object.keys(gState.gates||{}), hintsLoaded:(stageObj.hints||[]).length, triggersLoaded:(stageObj.triggers||[]).length };
    await message.reply("```json\n"+JSON.stringify(info,null,2)+"\n```").catch(()=>{});
    return;
  }

  // Run mystery before AI/catch-alls so triggers fire properly
  await handleMystery(message, content);

  // AI FALLBACK for anything addressed to Chad that wasn't caught
  if (/^\s*(?:chad|<@!?\d+>)/i.test(content)) {
    const stripped = content.replace(/^\s*(?:chad|<@!?\d+>)[, ]*/i, '');
    try {
      if (!openai) {
        await message.reply('⚠️ OPENAI_API_KEY is missing on the server, so I can’t use my brain.').catch(()=>{});
        return;
      }
      const ai = await aiAnswer(stripped);
      if (ai && ai.trim()) {
        await message.reply(ai).catch(()=>{});
        return;
      } else {
        console.error('AI returned empty/null. Input was:', stripped);
        await message.reply('⚠️ I glitched trying to talk to OpenAI. Check server logs.').catch(()=>{});
        return;
      }
    } catch (e) {
      console.error('OpenAI error:', e);
      await message.reply('⚠️ OpenAI call failed. See logs for details.').catch(()=>{});
      return;
    }
  }

  // Catch-alls so Chad answers when addressed
  if (/,chad\b/i.test(message.content) || /^chad\b/i.test(content)) {
    await message.reply(pick(CHAD_FALLBACKS)).catch(()=>{});
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
    } catch {}
  }, 1500);
});

// ---------- LOGIN ----------
client.login((process.env.DISCORD_TOKEN || '').trim());
