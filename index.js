// index.js — ESM, mystery + utilities + consent modes + OpenAI fallback

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';
import OpenAI from 'openai';

// ---------------- Config ----------------
const TZ  = (process.env.TIMEZONE || 'America/Winnipeg').trim();
const OWM = (process.env.OPENWEATHER_API_KEY || '').trim() || null;

const STATE_DIR  = fs.existsSync('/data') ? '/data' : path.resolve('./');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const BRAIN_PATH = path.resolve('./brain.json');

// ---------------- JSON helpers ----------------
function loadJSON(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// Load brain + state
let brain = loadJSON(BRAIN_PATH, { fortunes: ["the vending machine forgives you"] });
let state = loadJSON(STATE_PATH, {});

// Hot-reload brain.json minimally (optional; safe no-op if not desired)
fs.watch(BRAIN_PATH, { persistent: false }, () => {
  try { const next = loadJSON(BRAIN_PATH, brain); if (next) brain = next; }
  catch {}
});

// ---------------- Discord client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Using state path: ${STATE_PATH}`);

  // Ambient hauntings (every ~3h)
  setInterval(async () => {
    const pool = brain.ambient || [];
    if (!pool.length) return;
    for (const [gid] of client.guilds.cache) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const chan =
        guild.systemChannel ||
        guild.channels.cache.find(c => c?.isTextBased?.() && c?.viewable);
      if (!chan) continue;
      if (Math.random() < 0.35) chan.send(pick(pool)).catch(()=>{});
    }
  }, 1000 * 60 * 60 * 3);
});

// ---------------- Small utils ----------------
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function getGuildState(gid) {
  if (!state[gid]) {
    state[gid] = {
      stage: 1,
      gates: {},
      cooldowns: {},
      participants: {},
      prefs: { consents: {} }
    };
    saveJSON(STATE_PATH, state);
  }
  return state[gid];
}
function nowInWindow(sh, sm, eh, em) {
  const now = DateTime.now().setZone(TZ);
  const start = now.set({ hour: sh, minute: sm, second: 0 });
  const end   = now.set({ hour: eh, minute: em, second: 0 });
  return now >= start && now <= end;
}
function hasDailyCooldown(gState, key) {
  const stamp = gState.cooldowns[key];
  const today = DateTime.now().setZone(TZ).toISODate();
  return stamp === today;
}
function setDailyCooldown(gState, key) {
  gState.cooldowns[key] = DateTime.now().setZone(TZ).toISODate();
  saveJSON(STATE_PATH, state);
}
function tzAlias(name) {
  const s = (name || '').toLowerCase().trim();
  if (!s) return TZ;
  if (/(brandon|manitoba|winnipeg|mb|prairies)/.test(s)) return 'America/Winnipeg';
  if (/(new york|nyc|eastern)/.test(s)) return 'America/New_York';
  if (/(los angeles|la|pacific)/.test(s)) return 'America/Los_Angeles';
  if (/(london|uk|britain|gmt)/.test(s)) return 'Europe/London';
  return TZ;
}

// ---------------- Roast homage ----------------
const roastRegex = /(sts\b|over[-\s]?polic|too many rules|north\s*korea|rule\s*police)/i;
async function maybeRoast(message, gState) {
  if (!roastRegex.test(message.content)) return;
  if (hasDailyCooldown(gState, 'roast_daily')) return;
  const pool = brain.roast_pool || [];
  if (!pool.length) return;
  await message.reply(pick(pool)).catch(()=>{});
  setDailyCooldown(gState, 'roast_daily');
}

// ---------------- Roles/channels for finale ----------------
async function ensureKeyholderRole(guild) {
  let role = guild.roles.cache.find(r => r.name === 'Keyholder');
  if (!role) role = await guild.roles.create({
    name: 'Keyholder', color: 0xff66cc, reason: 'Mystery reward role'
  });
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

// ---------------- Hints ----------------
async function maybeHint(message, gState, stageObj) {
  if (!stageObj?.hints?.length) return;
  const key = `hint_${gState.stage}`;
  if (hasDailyCooldown(gState, key)) return;
  if (/^chad[, ]/i.test(message.content)) {
    await message.channel.send(pick(stageObj.hints)).catch(()=>{});
    setDailyCooldown(gState, key);
  }
}

// ---------------- Mystery engine ----------------
async function handleMystery(message) {
  const gState = getGuildState(message.guild.id);
  const stageObj = (brain.stages || []).find(s => s.number === gState.stage);
  if (!stageObj) return false;

  const triggered = (stageObj.triggers || []).some(rx => new RegExp(rx, 'i').test(message.content));
  if (!triggered) { await maybeHint(message, gState, stageObj); return false; }

  if (stageObj.timeWindow) {
    const [sh, sm, eh, em] = stageObj.timeWindow;
    if (!nowInWindow(sh, sm, eh, em)) {
      await message.reply(stageObj.timeLockedReply || "too early. so ambitious. so wrong.").catch(()=>{});
      return true;
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
      gState.gates.s6 = { sequence: [] };
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
      return true;
    }
    case 10: {
      await message.channel.send(stageObj.response).catch(()=>{});
      const role = await ensureKeyholderRole(message.guild);
      const chan = await ensureArchiveChannel(message.guild, role);
      const contributors = Object.keys(gState.participants || {});
      for (const uid of contributors) {
        const member = await message.guild.members.fetch(uid).catch(()=>null);
        if (member && !member.roles.cache.has(role.id)) await member.roles.add(role).catch(()=>{});
      }
      await chan.send(brain.finaleRoomWelcome || "Welcome, Keyholders.").catch(()=>{});
      break;
    }
    default: {
      await message.channel.send(stageObj.response).catch(()=>{});
    }
  }

  if (!stageObj.requiresGate) { gState.stage++; saveJSON(STATE_PATH, state); }
  else saveJSON(STATE_PATH, state);

  return true;
}

// ---------------- Utilities: time / weather / facts ----------------
function formatTime(zone) {
  const now = DateTime.now().setZone(zone || TZ);
  const nice = now.toFormat("ccc, LLL d 'at' h:mm a");
  return `🕰️ ${nice} (${zone})`;
}
async function fetchWeather(qRaw) {
  if (!OWM) return { err: "Weather not set up. (Add OPENWEATHER_API_KEY)" };
  const q = (qRaw || '').trim() || 'Brandon,CA';
  // Node 18+ has global fetch
  const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&appid=${OWM}&units=metric`);
  if (!r.ok) return { err: `couldn't fetch weather for "${q}".` };
  const d = await r.json();
  const desc = d.weather?.[0]?.description || 'weather';
  const t = Math.round(d.main?.temp ?? 0);
  const f = Math.round(d.main?.feels_like ?? t);
  const h = Math.round(d.main?.humidity ?? 0);
  const w = Math.round((d.wind?.speed ?? 0) * 3.6);
  return { text: `🌤️ ${d.name || q}: ${desc}, ${t}°C (feels ${f}°C), humidity ${h}%, wind ${w} km/h` };
}
function randomFact() {
  const pool = brain.facts_pool || [];
  if (!pool.length) return "default fact: chad once ate a neon sign for character development.";
  return pick(pool);
}

// ---------------- Consent & Modes ----------------
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function ensurePrefs(gState){ gState.prefs ??= { consents: {} }; }
function hasConsent(gState, uid, mode) {
  ensurePrefs(gState);
  const c = gState.prefs.consents[uid];
  if (!c || !c[mode]) return false;
  if (Date.now() - (c.ts || 0) > ONE_DAY_MS) {
    delete gState.prefs.consents[uid];
    saveJSON(STATE_PATH, state);
    return false;
  }
  return true;
}
function giveConsent(gState, uid, mode) {
  ensurePrefs(gState);
  gState.prefs.consents[uid] = { ...(gState.prefs.consents[uid] || {}), [mode]: true, ts: Date.now() };
  saveJSON(STATE_PATH, state);
}
function clearConsent(gState, uid) {
  ensurePrefs(gState);
  delete gState.prefs.consents[uid];
  saveJSON(STATE_PATH, state);
}
function isNSFW(message) {
  const ch = message.channel;
  return Boolean(ch.nsfw || ch.parent?.nsfw);
}
function hasDungeonRole(member) {
  return member?.roles?.cache?.some(r => /dungeon dweller/i.test(r.name));
}
function pickFrom(key) {
  const pool = brain[key] || [];
  return pool.length ? pick(pool) : null;
}

// ---------------- OpenAI (fallback) ----------------
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;
const AI_MODEL = (process.env.CHAD_AI_MODEL || 'gpt-4o-mini').trim();
const SYSTEM_CHAD = `
You are "Chad", the Moonlit Motel desk clerk: witty, kind, and a little feral.
Stay in-universe; be helpful. Keep replies concise unless asked. Avoid NSFW unless in NSFW channels.
Offer time/weather when asked. Never invent server rules; keep the vibe cozy and weird.
`;

// ---------------- Message handler ----------------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const gState = getGuildState(message.guild.id);
  gState.participants[message.author.id] = true;
  const content = message.content;

  // Roast homage (rate-limited daily per guild)
  await maybeRoast(message, gState);

  // Ask the motel (fortunes)
  if (/^chad,\s*ask the motel\b/i.test(content)) {
    const pool = brain.fortunes || [];
    if (pool.length) { await message.reply(pick(pool)).catch(()=>{}); return; }
  }

  // Random fact
  if (/^chad,\s*(random fact|fact)$/i.test(content)) {
    await message.reply(`📎 ${randomFact()}`).catch(()=>{});
    return;
  }

  // Time (aliases)
  const timeMatch =
    content.match(/^chad,\s*time(?:\s+in\s+(.+))?$/i) ||
    content.match(/^chad,\s*what(?:'s| is)\s+the\s+time(?:\s+in\s+(.+))?$/i);
  if (timeMatch) {
    const place = timeMatch[1];
    const zone = tzAlias(place);
    await message.reply(formatTime(zone)).catch(()=>{});
    return;
  }

  // Weather
  const wMatch =
    content.match(/^chad,\s*weather(?:\s+in\s+(.+))?$/i) ||
    content.match(/^chad,\s*what(?:'s| is)\s+the\s+weather(?:\s+in\s+(.+))?$/i);
  if (wMatch) {
    const city = (wMatch[1] || '').trim();
    const res = await fetchWeather(city);
    await message.reply(res.err ? `⚠️ ${res.err}` : res.text).catch(()=>{});
    return;
  }

  // Easter eggs from brain.json
  for (const egg of (brain.easter_eggs || [])) {
    try {
      const re = new RegExp(egg.trigger_regex, 'i');
      if (re.test(content)) {
        if (egg.responses_key && brain[egg.responses_key]) {
          await message.reply(pick(brain[egg.responses_key])).catch(()=>{});
        } else if (Array.isArray(egg.responses) && egg.responses.length) {
          await message.reply(pick(egg.responses)).catch(()=>{});
        }
        return;
      }
    } catch {}
  }

  // Consent commands
  if (/^chad,\s*consent\s+(mean|flirt|petty)\s*$/i.test(content)) {
    const mode = content.match(/(mean|flirt|petty)/i)[1].toLowerCase();
    giveConsent(gState, message.author.id, mode);
    await message.reply(`✅ consent recorded for **${mode}** (24h). say “chad, be ${mode} to me”.`).catch(()=>{});
    return;
  }
  if (/^chad,\s*opt\s*out$/i.test(content)) {
    clearConsent(gState, message.author.id);
    await message.reply("✅ consent cleared. i’ll behave. for now.").catch(()=>{});
    return;
  }

  // Mode prompts
  if (/^chad,\s*be\s+mean\s+to\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'mean'))
      return void message.reply("i need your consent. say: `chad, consent mean` (expires in 24h).").catch(()=>{});
    const line = pickFrom('mean_lines') || "mean mode unavailable.";
    await message.reply(line).catch(()=>{});
    return;
  }
  if (/^chad,\s*be\s+petty\s+to\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'petty'))
      return void message.reply("need consent first. say: `chad, consent petty`.").catch(()=>{});
    const line = pickFrom('petty_lines') || "petty mode unavailable.";
    await message.reply(line).catch(()=>{});
    return;
  }
  if (/^chad,\s*flirt\s+with\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'flirt'))
      return void message.reply("need consent. say: `chad, consent flirt`.").catch(()=>{});
    let poolKey = 'flirt_sfw';
    if (isNSFW(message) && hasDungeonRole(message.member)) poolKey = 'flirt_spicy';
    const line = pickFrom(poolKey) || "flirt mode unavailable.";
    await message.reply(line).catch(()=>{});
    return;
  }

  // Mystery collectors before routing
  // Stage 3: collect 5 unique "I never..." confessions
  if (gState.stage === 3 && gState.gates.s3) {
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

  // Stage 6: alternating pattern
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

  // Stage 7: apology + forgiveness in window
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

  // Route to stage handler
  const mysteryHit = await handleMystery(message);
  if (mysteryHit) return;

  // ---------- Health check ----------
  if (/^chad,\s*diag\s+openai$/i.test(content)) {
    if (!openai) { await message.reply('❌ OPENAI_API_KEY missing on the server env.').catch(()=>{}); return; }
    try {
      const test = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [{ role: 'user', content: 'Say OK' }],
        max_tokens: 5
      });
      await message.reply('✅ OpenAI OK: ' + (test.choices?.[0]?.message?.content || 'no content')).catch(()=>{});
    } catch (e) {
      console.error('OpenAI diag error:', e?.status, e?.code, e?.message);
      await message.reply('❌ OpenAI diag failed. Check logs.').catch(()=>{});
    }
    return;
  }

  // ---------- ALWAYS-ON OpenAI fallback ----------
  if (/^\s*(?:chad|<@!?\d+>)[, ]/i.test(content)) {
    const stripped = content.replace(/^\s*(?:chad|<@!?\d+>)[, ]*/i, '').trim() || 'say hello to the room.';
    try {
      if (!openai) {
        await message.reply('⚠️ my brain (OpenAI) is offline. poke the Innkeeper about OPENAI_API_KEY.').catch(()=>{});
        return;
      }
      const resp = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.8,
        messages: [
          { role: 'system', content: SYSTEM_CHAD },
          { role: 'user', content: stripped }
        ]
      });
      const out = resp.choices?.[0]?.message?.content?.trim();
      await message.reply(out || "…the neon hums, but the words got stuck.").catch(()=>{});
    } catch (e) {
      console.error('OpenAI fallback error:', e?.status, e?.code, e?.message);
      await message.reply('⚠️ the neon hums but i can’t reach the brain right now.').catch(()=>{});
    }
    return;
  }

  // Gentle catch-all if users type “chad” without comma
  if (/^chad\b/i.test(content)) {
    const fallbacks = brain.lore_tip
      ? [brain.lore_tip, "ask me for **weather**, **time**, a **hint**, or **what’s wrong with the motel**."]
      : ["ask me for **weather**, **time**, a **hint**, or **what’s wrong with the motel**."];
    await message.reply(pick(fallbacks)).catch(()=>{});
  }
});

// ---------------- Reaction watcher (Stage 9 poll) ----------------
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

// ---------------- Login ----------------
client.login((process.env.DISCORD_TOKEN || '').trim());
