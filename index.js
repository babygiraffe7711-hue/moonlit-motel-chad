// CommonJS version (stable on Render + Node 20)
require('dotenv').config();

const { Client, GatewayIntentBits, Partials, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// node-fetch (ESM) shim for CJS:
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ------------ Config ------------
const TZ = process.env.TIMEZONE || 'America/Winnipeg';
const OWM = process.env.OPENWEATHER_API_KEY || null;

// Prefer persistent disk at /data
const STATE_DIR = fs.existsSync('/data') ? '/data' : path.resolve('./');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const BRAIN_PATH = path.resolve('./brain.json');

// ------------ JSON helpers ------------
function loadJSON(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// Load brain + state
let brain = loadJSON(BRAIN_PATH, { fortunes: ["default fortune"] });
let state = loadJSON(STATE_PATH, {});

// ------------ Discord client ------------
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
  // Ambient hauntings every ~3h
  setInterval(async () => {
    if (!brain.ambient?.length) return;
    for (const [gid] of client.guilds.cache) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const chan = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased?.() && c.viewable);
      if (!chan) continue;
      if (Math.random() < 0.35) chan.send(pick(brain.ambient));
    }
  }, 1000 * 60 * 60 * 3);
});

// ------------ Small utils ------------
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function getGuildState(gid) {
  if (!state[gid]) {
    state[gid] = { stage: 1, gates: {}, cooldowns: {}, participants: {}, prefs: { consents: {} } };
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
  if (/(brandon|manitoba|winnipeg|mb)/.test(s)) return 'America/Winnipeg';
  if (/(new york|nyc|eastern)/.test(s)) return 'America/New_York';
  if (/(los angeles|la|pacific)/.test(s)) return 'America/Los_Angeles';
  if (/(london|uk|britain|gmt)/.test(s)) return 'Europe/London';
  return TZ;
}

// ------------ Roast homage ------------
const roastRegex = /(sts\b|over[-\s]?polic|too many rules|north\s*korea|rule\s*police)/i;
async function maybeRoast(message, gState) {
  if (!roastRegex.test(message.content)) return;
  if (hasDailyCooldown(gState, 'roast_daily')) return;
  const pool = brain.roast_pool || [];
  if (!pool.length) return;
  await message.reply(pick(pool));
  setDailyCooldown(gState, 'roast_daily');
}

// ------------ Roles/channels for finale ------------
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

// ------------ Hints ------------
async function maybeHint(message, gState, stageObj) {
  if (!stageObj.hints?.length) return;
  const key = `hint_${gState.stage}`;
  if (hasDailyCooldown(gState, key)) return;
  if (/^chad[, ]/i.test(message.content)) {
    await message.channel.send(pick(stageObj.hints));
    setDailyCooldown(gState, key);
  }
}

// ------------ Mystery engine ------------
async function handleMystery(message) {
  const gState = getGuildState(message.guild.id);
  const stageObj = (brain.stages || []).find(s => s.number === gState.stage);
  if (!stageObj) return;

  const triggered = (stageObj.triggers || []).some(rx => new RegExp(rx, 'i').test(message.content));
  if (!triggered) { await maybeHint(message, gState, stageObj); return; }

  if (stageObj.timeWindow) {
    const [sh, sm, eh, em] = stageObj.timeWindow;
    if (!nowInWindow(sh, sm, eh, em)) {
      await message.reply(stageObj.timeLockedReply || "too early. so ambitious. so wrong.");
      return;
    }
  }

  switch (gState.stage) {
    case 3: {
      await message.channel.send(stageObj.response);
      await message.channel.send(stageObj.taskPrompt);
      gState.gates.s3 = gState.gates.s3 || { confessors: {} };
      break;
    }
    case 6: {
      await message.channel.send(stageObj.response);
      await message.channel.send(stageObj.taskPrompt);
      gState.gates.s6 = { sequence: [] };
      break;
    }
    case 7: {
      await message.channel.send(stageObj.response);
      await message.channel.send(stageObj.taskPrompt);
      gState.gates.s7 = { apologyBy: null, forgivenessBy: null };
      break;
    }
    case 9: {
      const pollMsg = await message.channel.send(stageObj.response);
      await pollMsg.react('✅'); await pollMsg.react('❌');
      gState.gates.s9 = { pollId: pollMsg.id, closed: false };
      saveJSON(STATE_PATH, state);
      return;
    }
    case 10: {
      await message.channel.send(stageObj.response);
      const role = await ensureKeyholderRole(message.guild);
      const chan = await ensureArchiveChannel(message.guild, role);
      const contributors = Object.keys(gState.participants || {});
      for (const uid of contributors) {
        const member = await message.guild.members.fetch(uid).catch(()=>null);
        if (member && !member.roles.cache.has(role.id)) {
          await member.roles.add(role).catch(()=>{});
        }
      }
      await chan.send(brain.finaleRoomWelcome || "Welcome, Keyholders.");
      break;
    }
    default: {
      await message.channel.send(stageObj.response);
    }
  }

  if (!stageObj.requiresGate) {
    gState.stage++;
    saveJSON(STATE_PATH, state);
  } else {
    saveJSON(STATE_PATH, state);
  }
}

// ------------ Utilities: time / weather / facts ------------
function formatTime(zone) {
  const now = DateTime.now().setZone(zone || TZ);
  const nice = now.toFormat("ccc, LLL d 'at' h:mm a");
  return `🕰️ ${nice} (${zone})`;
}
async function fetchWeather(qRaw) {
  if (!OWM) return { err: "Weather not set up. (Add OPENWEATHER_API_KEY)" };
  const q = (qRaw || '').trim() || 'Brandon,CA';
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&appid=${OWM}&units=metric`;
  const r = await fetch(url);
  if (!r.ok) return { err: `couldn't fetch weather for "${q}".` };
  const data = await r.json();
  const d = data.weather?.[0]?.description || 'weather';
  const t = Math.round(data.main?.temp ?? 0);
  const f = Math.round(data.main?.feels_like ?? t);
  const h = Math.round(data.main?.humidity ?? 0);
  const w = Math.round((data.wind?.speed ?? 0) * 3.6);
  return { text: `🌤️ ${q}: ${d}, ${t}°C (feels ${f}°C), humidity ${h}%, wind ${w} km/h` };
}
function randomFact() {
  const pool = brain.facts_pool || [];
  if (!pool.length) return "default fact: chad once ate a neon sign for character development.";
  return pick(pool);
}

// ------------ Consent & Modes ------------
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function hasConsent(gState, uid, mode) {
  gState.prefs ??= { consents: {} };
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
  gState.prefs ??= { consents: {} };
  gState.prefs.consents[uid] = { ...(gState.prefs.consents[uid] || {}), [mode]: true, ts: Date.now() };
  saveJSON(STATE_PATH, state);
}
function clearConsent(gState, uid) {
  gState.prefs ??= { consents: {} };
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

// ------------ Message handler ------------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const gState = getGuildState(message.guild.id);
  gState.participants[message.author.id] = true;

  const content = message.content;

  await maybeRoast(message, gState);

  // Ask the motel (fortunes)
  if (/^chad,\s*ask the motel\b/i.test(content)) {
    const pool = brain.fortunes || [];
    if (pool.length) { await message.reply(pick(pool)); return; }
  }

  // Facts
  if (/^chad,\s*(random fact|fact)$/i.test(content)) {
    await message.reply(`📎 ${randomFact()}`);
    return;
  }

  // Time
  const timeMatch = content.match(/^chad,\s*time(?:\s+in\s+(.+))?$/i) || content.match(/^chad,\s*what(?:'s| is)\s+the\s+time(?:\s+in\s+(.+))?$/i);
  if (timeMatch) {
    const place = timeMatch[1];
    const zone = tzAlias(place);
    await message.reply(formatTime(zone));
    return;
  }

  // Weather
  const wMatch = content.match(/^chad,\s*weather(?:\s+in\s+(.+))?$/i) || content.match(/^chad,\s*what(?:'s| is)\s+the\s+weather(?:\s+in\s+(.+))?$/i);
  if (wMatch) {
    const city = (wMatch[1] || '').trim();
    const res = await fetchWeather(city);
    if (res.err) await message.reply(`⚠️ ${res.err}`);
    else await message.reply(res.text);
    return;
  }

  // Easter eggs
  for (const egg of (brain.easter_eggs || [])) {
    const re = new RegExp(egg.trigger_regex, 'i');
    if (re.test(content)) {
      if (egg.responses_key && brain[egg.responses_key]) {
        await message.reply(pick(brain[egg.responses_key]));
      } else if (egg.responses?.length) {
        await message.reply(pick(egg.responses));
      }
      return;
    }
  }

  // Consent commands
  if (/^chad,\s*consent\s+(mean|flirt|petty)\s*$/i.test(content)) {
    const mode = content.match(/(mean|flirt|petty)/i)[1].toLowerCase();
    giveConsent(gState, message.author.id, mode);
    await message.reply(`✅ consent recorded for **${mode}** (24h). say “chad, be ${mode} to me”.`);
    return;
  }
  if (/^chad,\s*opt\s*out$/i.test(content)) {
    clearConsent(gState, message.author.id);
    await message.reply("✅ consent cleared. i’ll behave. for now.");
    return;
  }

  // Mode prompts
  if (/^chad,\s*be\s+mean\s+to\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'mean'))
      return void message.reply("i need your consent. say: `chad, consent mean` (expires in 24h).");
    const line = pickFrom('mean_lines') || "mean mode unavailable.";
    await message.reply(line); return;
  }
  if (/^chad,\s*be\s+petty\s+to\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'petty'))
      return void message.reply("need consent first. say: `chad, consent petty`.");
    const line = pickFrom('petty_lines') || "petty mode unavailable.";
    await message.reply(line); return;
  }
  if (/^chad,\s*flirt\s+with\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'flirt'))
      return void message.reply("need consent. say: `chad, consent flirt`.");
    let poolKey = 'flirt_sfw';
    if (isNSFW(message) && hasDungeonRole(message.member)) poolKey = 'flirt_spicy';
    const line = pickFrom(poolKey) || "flirt mode unavailable.";
    await message.reply(line); return;
  }

  // Mystery collectors before routing
  if (gState.stage === 3 && gState.gates.s3) {
    const isConfession = /(\bi never\b|\bi’ve?\s+never\b|\bi have never\b)/i.test(content);
    if (isConfession) {
      gState.gates.s3.confessors[message.author.id] = true;
      const count = Object.keys(gState.gates.s3.confessors).length;
      if (count >= 5) {
        await message.channel.send("✅ *Delicious.* Honesty always tastes a bit like blood. The lock twitched. Try the **ledger** next—if it doesn’t bite first.");
        gState.stage = 4; delete gState.gates.s3;
      } else {
        await message.channel.send(`confession logged (${count}/5). the motel is listening.`);
      }
      saveJSON(STATE_PATH, state); return;
    }
  }
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
        await message.channel.send(`pattern accepted (${progress}/6).`);
        if (progress >= 6) {
          await message.channel.send("✅ The light purrs. Doors adjust their posture. Something’s ready to be said out loud.");
          gState.stage = 7; delete gState.gates.s6; saveJSON(STATE_PATH, state);
        } else saveJSON(STATE_PATH, state);
      } else {
        await message.channel.send("nope. wrong flavor. alternate confession ↔ joke.");
      }
    }
  }
  if (gState.stage === 7 && gState.gates.s7) {
    const s7 = gState.gates.s7;
    if (!s7.apologyBy && /\b(sorry|apologize|apology)\b/i.test(content)) {
      s7.apologyBy = message.author.id;
      await message.channel.send("apology archived. one more: forgiveness.");
      saveJSON(STATE_PATH, state);
    } else if (!s7.forgivenessBy && /\b(i forgive|i’m forgiving|i forgive you)\b/i.test(content)) {
      s7.forgivenessBy = message.author.id;
      await message.channel.send("✅ Accepted. The walls exhaled. next time, bring snacks.");
      gState.stage = 8; delete gState.gates.s7; saveJSON(STATE_PATH, state);
    }
  }

  await handleMystery(message);
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || !reaction.message.guild) return;
  const gState = getGuildState(reaction.message.guild.id);
  if (gState.stage !== 9 || !gState.gates.s9) return;
  if (reaction.message.id !== gState.gates.s9.pollId) return;

  setTimeout(async () => {
    const msg = await reaction.message.fetch();
    const yes = (await msg.reactions.resolve('✅')?.users.fetch())?.filter(u => !u.bot).size || 0;
    const no  = (await msg.reactions.resolve('❌')?.users.fetch())?.filter(u => !u.bot).size || 0;

    if (!gState.gates.s9.closed && (yes + no) >= 3) {
      gState.gates.s9.closed = true;
      if (yes >= 2 && yes > no) {
        await msg.reply("…you picked me. tragic. iconic. The door unlocks with a sound like laughter through teeth.");
        gState.stage = 10;
      } else {
        await msg.reply("understood. deactivating emotional subroutines. goodbye forever. (back tomorrow.)");
        gState.stage = 10;
      }
      saveJSON(STATE_PATH, state);
    }
  }, 1500);
});

client.login(process.env.DISCORD_TOKEN);
// per-guild state
function getGuildState(gid) {
  if (!state[gid]) {
    state[gid] = { stage: 1, gates: {}, cooldowns: {}, participants: {}, prefs: { consents: {} } };
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

// timezone alias (quick wins)
function tzAlias(name) {
  const s = (name || '').toLowerCase().trim();
  if (!s) return TZ;
  if (/(brandon|manitoba|winnipeg|mb)/.test(s)) return 'America/Winnipeg';
  if (/(new york|nyc|eastern)/.test(s)) return 'America/New_York';
  if (/(los angeles|la|pacific)/.test(s)) return 'America/Los_Angeles';
  if (/(london|uk|britain|gmt)/.test(s)) return 'Europe/London';
  return TZ;
}

// ------------ Roast homage ------------
const roastRegex = /(sts\b|over[-\s]?polic|too many rules|north\s*korea|rule\s*police)/i;
async function maybeRoast(message, gState) {
  if (!roastRegex.test(message.content)) return;
  if (hasDailyCooldown(gState, 'roast_daily')) return;
  const pool = brain.roast_pool || [];
  if (!pool.length) return;
  await message.reply(pick(pool));
  setDailyCooldown(gState, 'roast_daily');
}

// ------------ Roles/channels for finale ------------
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

// ------------ Hints ------------
async function maybeHint(message, gState, stageObj) {
  if (!stageObj.hints?.length) return;
  const key = `hint_${gState.stage}`;
  if (hasDailyCooldown(gState, key)) return;
  if (/^chad[, ]/i.test(message.content)) {
    await message.channel.send(pick(stageObj.hints));
    setDailyCooldown(gState, key);
  }
}

// ------------ Mystery engine ------------
async function handleMystery(message) {
  const gState = getGuildState(message.guild.id);
  const stageObj = (brain.stages || []).find(s => s.number === gState.stage);
  if (!stageObj) return;

  const triggered = (stageObj.triggers || []).some(rx => new RegExp(rx, 'i').test(message.content));
  if (!triggered) { await maybeHint(message, gState, stageObj); return; }

  if (stageObj.timeWindow) {
    const [sh, sm, eh, em] = stageObj.timeWindow;
    if (!nowInWindow(sh, sm, eh, em)) {
      await message.reply(stageObj.timeLockedReply || "too early. so ambitious. so wrong.");
      return;
    }
  }

  switch (gState.stage) {
    case 3: {
      await message.channel.send(stageObj.response);
      await message.channel.send(stageObj.taskPrompt);
      gState.gates.s3 = gState.gates.s3 || { confessors: {} };
      break;
    }
    case 6: {
      await message.channel.send(stageObj.response);
      await message.channel.send(stageObj.taskPrompt);
      gState.gates.s6 = { sequence: [] };
      break;
    }
    case 7: {
      await message.channel.send(stageObj.response);
      await message.channel.send(stageObj.taskPrompt);
      gState.gates.s7 = { apologyBy: null, forgivenessBy: null };
      break;
    }
    case 9: {
      const pollMsg = await message.channel.send(stageObj.response);
      await pollMsg.react('✅'); await pollMsg.react('❌');
      gState.gates.s9 = { pollId: pollMsg.id, closed: false };
      saveJSON(STATE_PATH, state);
      return;
    }
    case 10: {
      await message.channel.send(stageObj.response);
      const role = await ensureKeyholderRole(message.guild);
      const chan = await ensureArchiveChannel(message.guild, role);
      const contributors = Object.keys(gState.participants || {});
      for (const uid of contributors) {
        const member = await message.guild.members.fetch(uid).catch(()=>null);
        if (member && !member.roles.cache.has(role.id)) {
          await member.roles.add(role).catch(()=>{});
        }
      }
      await chan.send(brain.finaleRoomWelcome || "Welcome, Keyholders.");
      break;
    }
    default: {
      await message.channel.send(stageObj.response);
    }
  }

  if (!stageObj.requiresGate) {
    gState.stage++;
    saveJSON(STATE_PATH, state);
  } else {
    saveJSON(STATE_PATH, state);
  }
}

// ------------ Utilities: time / weather / facts ------------
function formatTime(zone) {
  const now = DateTime.now().setZone(zone || TZ);
  const nice = now.toFormat("ccc, LLL d 'at' h:mm a");
  return `🕰️ ${nice} (${zone})`;
}
async function fetchWeather(qRaw) {
  if (!OWM) return { err: "Weather not set up. (Add OPENWEATHER_API_KEY)" };
  const q = (qRaw || '').trim() || 'Brandon,CA';
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&appid=${OWM}&units=metric`;
  const r = await fetch(url);
  if (!r.ok) return { err: `couldn't fetch weather for "${q}".` };
  const data = await r.json();
  const d = data.weather?.[0]?.description || 'weather';
  const t = Math.round(data.main?.temp ?? 0);
  const f = Math.round(data.main?.feels_like ?? t);
  const h = Math.round(data.main?.humidity ?? 0);
  const w = Math.round((data.wind?.speed ?? 0) * 3.6); // m/s → km/h
  return { text: `🌤️ ${q}: ${d}, ${t}°C (feels ${f}°C), humidity ${h}%, wind ${w} km/h` };
}
function randomFact() {
  const pool = brain.facts_pool || [];
  if (!pool.length) return "default fact: chad once ate a neon sign for character development.";
  return pick(pool);
}

// ------------ Consent & Modes ------------
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function ensurePrefs(gState) {
  if (!gState.prefs) gState.prefs = { consents: {} };
}
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

// ------------ Message handler ------------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const gState = getGuildState(message.guild.id);
  gState.participants[message.author.id] = true;

  const content = message.content;

  // Homage roast (rate-limited daily per guild)
  await maybeRoast(message, gState);

  // Ask the motel (fortunes)
  if (/^chad,\s*ask the motel\b/i.test(content)) {
    const pool = brain.fortunes || [];
    if (pool.length) { await message.reply(pick(pool)); return; }
  }

  // Facts
  if (/^chad,\s*(random fact|fact)$/i.test(content)) {
    await message.reply(`📎 ${randomFact()}`);
    return;
  }

  // Time
  const timeMatch = content.match(/^chad,\s*time(?:\s+in\s+(.+))?$/i) || content.match(/^chad,\s*what(?:'s| is)\s+the\s+time(?:\s+in\s+(.+))?$/i);
  if (timeMatch) {
    const place = timeMatch[1];
    const zone = tzAlias(place);
    await message.reply(formatTime(zone));
    return;
  }

  // Weather
  const wMatch = content.match(/^chad,\s*weather(?:\s+in\s+(.+))?$/i) || content.match(/^chad,\s*what(?:'s| is)\s+the\s+weather(?:\s+in\s+(.+))?$/i);
  if (wMatch) {
    const city = (wMatch[1] || '').trim();
    const res = await fetchWeather(city);
    if (res.err) await message.reply(`⚠️ ${res.err}`);
    else await message.reply(res.text);
    return;
  }

  // Easter eggs
  for (const egg of (brain.easter_eggs || [])) {
    const re = new RegExp(egg.trigger_regex, 'i');
    if (re.test(content)) {
      if (egg.responses_key && brain[egg.responses_key]) {
        await message.reply(pick(brain[egg.responses_key]));
      } else if (egg.responses?.length) {
        await message.reply(pick(egg.responses));
      }
      return;
    }
  }

  // ---------- Consent commands ----------
  if (/^chad,\s*consent\s+(mean|flirt|petty)\s*$/i.test(content)) {
    const mode = content.match(/(mean|flirt|petty)/i)[1].toLowerCase();
    giveConsent(gState, message.author.id, mode);
    await message.reply(`✅ consent recorded for **${mode}** (24h). say “chad, be ${mode} to me”.`);
    return;
  }
  if (/^chad,\s*opt\s*out$/i.test(content)) {
    clearConsent(gState, message.author.id);
    await message.reply("✅ consent cleared. i’ll behave. for now.");
    return;
  }

  // ---------- Mode prompts ----------
  if (/^chad,\s*be\s+mean\s+to\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'mean'))
      return void message.reply("i need your consent. say: `chad, consent mean` (expires in 24h).");
    const line = pickFrom('mean_lines') || "mean mode unavailable.";
    await message.reply(line);
    return;
  }

  if (/^chad,\s*be\s+petty\s+to\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'petty'))
      return void message.reply("need consent first. say: `chad, consent petty`.");
    const line = pickFrom('petty_lines') || "petty mode unavailable.";
    await message.reply(line);
    return;
  }

  if (/^chad,\s*flirt\s+with\s+me$/i.test(content)) {
    if (!hasConsent(gState, message.author.id, 'flirt'))
      return void message.reply("need consent. say: `chad, consent flirt`.");
    let poolKey = 'flirt_sfw';
    if (isNSFW(message) && hasDungeonRole(message.member)) poolKey = 'flirt_spicy';
    const line = pickFrom(poolKey) || "flirt mode unavailable.";
    await message.reply(line);
    return;
  }

  // ---------- Mystery collectors before routing ----------
  // Stage 3: collect 5 unique confessions ("i never" etc.)
  if (gState.stage === 3 && gState.gates.s3) {
    const isConfession = /(\bi never\b|\bi’ve?\s+never\b|\bi have never\b)/i.test(content);
    if (isConfession) {
      gState.gates.s3.confessors[message.author.id] = true;
      const count = Object.keys(gState.gates.s3.confessors).length;
      if (count >= 5) {
        await message.channel.send("✅ *Delicious.* Honesty always tastes a bit like blood. The lock twitched. Try the **ledger** next—if it doesn’t bite first.");
        gState.stage = 4; delete gState.gates.s3;
      } else {
        await message.channel.send(`confession logged (${count}/5). the motel is listening.`);
      }
      saveJSON(STATE_PATH, state);
      return;
    }
  }
  // Stage 6: alternating conf/joke pattern
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
        await message.channel.send(`pattern accepted (${progress}/6).`);
        if (progress >= 6) {
          await message.channel.send("✅ The light purrs. Doors adjust their posture. Something’s ready to be said out loud.");
          gState.stage = 7; delete gState.gates.s6; saveJSON(STATE_PATH, state);
        } else saveJSON(STATE_PATH, state);
      } else {
        await message.channel.send("nope. wrong flavor. alternate confession ↔ joke.");
      }
    }
  }
  // Stage 7: apology + forgiveness in window
  if (gState.stage === 7 && gState.gates.s7) {
    const s7 = gState.gates.s7;
    if (!s7.apologyBy && /\b(sorry|apologize|apology)\b/i.test(content)) {
      s7.apologyBy = message.author.id;
      await message.channel.send("apology archived. one more: forgiveness.");
      saveJSON(STATE_PATH, state);
    } else if (!s7.forgivenessBy && /\b(i forgive|i’m forgiving|i forgive you)\b/i.test(content)) {
      s7.forgivenessBy = message.author.id;
      await message.channel.send("✅ Accepted. The walls exhaled. next time, bring snacks.");
      gState.stage = 8; delete gState.gates.s7; saveJSON(STATE_PATH, state);
    }
  }

  // Route to mystery stage handler
  await handleMystery(message);
});

// Reaction watcher for Stage 9 vote
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || !reaction.message.guild) return;
  const gState = getGuildState(reaction.message.guild.id);
  if (gState.stage !== 9 || !gState.gates.s9) return;
  if (reaction.message.id !== gState.gates.s9.pollId) return;

  setTimeout(async () => {
    const msg = await reaction.message.fetch();
    const yes = (await msg.reactions.resolve('✅')?.users.fetch())?.filter(u => !u.bot).size || 0;
    const no  = (await msg.reactions.resolve('❌')?.users.fetch())?.filter(u => !u.bot).size || 0;

    if (!gState.gates.s9.closed && (yes + no) >= 3) {
      gState.gates.s9.closed = true;
      if (yes >= 2 && yes > no) {
        await msg.reply("…you picked me. tragic. iconic. The door unlocks with a sound like laughter through teeth.");
        gState.stage = 10;
      } else {
        await msg.reply("understood. deactivating emotional subroutines. goodbye forever. (back tomorrow.)");
        gState.stage = 10;
      }
      saveJSON(STATE_PATH, state);
    }
  }, 1500);
});

client.login(process.env.DISCORD_TOKEN);_MAP[last]) return TZ_MAP[last];
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

// ---------- AI (OpenAI) ----------
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_ORG = (process.env.OPENAI_ORG_ID || '').trim() || undefined;
const OPENAI_PROJECT = (process.env.OPENAI_PROJECT || '').trim() || undefined;

const openai = OPENAI_KEY ? new OpenAI({
  apiKey: OPENAI_KEY,
  organization: OPENAI_ORG,
  project: OPENAI_PROJECT
}) : null;

const AI_MODEL = (process.env.CHAD_AI_MODEL || 'gpt-4o-mini').trim();

const SYSTEM_CHAD = `
You are "Chad", the Moonlit Motel desk clerk: witty, kind, a little feral.
Be concise and helpful. Stay in-universe but use tools for facts (time/weather/justice/basement/roles).
Never invent server rules; call tools I give you.
If a question is clearly "mystery progression", say: "try the mirror, the light, or the ledger."
`;

// ✅ Correct tools schema
const toolDefs = [
  {
    type: "function",
    function: {
      name: "tool_time",
      description: "Return local time for a place",
      parameters: {
        type: "object",
        properties: { place: { type: "string" } },
        required: ["place"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "tool_weather",
      description: "Return current weather for a place",
      parameters: {
        type: "object",
        properties: { place: { type: "string" } },
        required: ["place"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "tool_basement",
      description: "Explain Basement/NSFW and who runs it",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "tool_justice",
      description: "Explain Motel justice/court system",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "tool_roles",
      description: "Explain server roles",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
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
  if (!openai) return null;

  const messages = [{ role:"system", content:SYSTEM_CHAD }, { role:"user", content:userText }];

  // simple retry helper
  async function callOnce() {
    const resp = await openai.chat.completions.create({
      model: AI_MODEL,
      messages,
      tools: toolDefs,
      tool_choice: "auto",
      temperature: 0.7
    });
    return resp.choices[0].message;
  }

  let msg;
  try {
    msg = await callOnce();
  } catch (e) {
    await new Promise(r=>setTimeout(r, 600));
    msg = await callOnce();
  }

  // Tool call flow (✅ include tool_call_id)
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
        { role:"tool", tool_call_id: call.id, content: toolResult }
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

// ---------- MYSTERY (returns boolean: did we reply?) ----------
async function handleMystery(message, contentNorm) {
  const gState = getGuildState(message.guild.id);
  const stageObj = (brain.stages || []).find(s => s.number === gState.stage);
  if (!stageObj) return false;

  const triggered = (stageObj.triggers || []).some(rx => new RegExp(rx, 'i').test(contentNorm));
  if (!triggered) { await maybeHint(message, gState, stageObj, contentNorm); return false; }

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
      if (pollMsg){ await pollMsg.react('✅').catch(()=>{}); await pollMsg.react('❌').catch(()=>{}); }
      gState.gates.s9 = { pollId: pollMsg?.id || null, closed: false };
      saveJSON(STATE_PATH, state);
      return true;
    }
    case 10: {
      await message.channel.send(stageObj.response).catch(()=>{});
      const role = await ensureKeyholderRole(message.guild);
      const chan = await ensureArchiveChannel(message.guild, role);
      const contributors = Object.keys(gState.participants || {});
      for (const uid of contributors){
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
  if (!stageObj.requiresGate) { gState.stage++; saveJSON(STATE_PATH, state); } else saveJSON(STATE_PATH, state);
  return true;
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

  // event visibility diag
  console.log('[evt] messageCreate', {
    guild: !!message.guild,
    authorBot: message.author?.bot,
    contentLen: (message.content || '').length,
    channel: message.channel?.id,
    thread: !!message.channel?.isThread?.(),
  });

  const gState = getGuildState(message.guild.id);
  gState.participants[message.author.id] = true;

  const content = normalizeWake(message.content || '', client);

  // Quick health check
  if (/^chad[, ]\s*diag\s+openai$/i.test(content)) {
    try {
      if (!openai) {
        await message.reply('❌ OPENAI_API_KEY missing (server env).').catch(()=>{});
      } else {
        const result = await openai.chat.completions.create({
          model: AI_MODEL,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 5
        });
        await message.reply('✅ OpenAI OK: ' + (result.choices?.[0]?.message?.content || 'no content')).catch(()=>{});
      }
    } catch (e) {
      console.error('OpenAI diag error:', {
        status: e?.status, code: e?.code, type: e?.type, msg: e?.message, data: e?.response?.data
      });
      await message.reply(`❌ OpenAI diag failed (${e?.status || 'no-status'}). Check logs.`).catch(()=>{});
    }
    return;
  }

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

  // TIME
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

  // BASEMENT / DUNGEON
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

  // ROUTE INTENTS
  const intentHit = await routeIntent(message, content, gState);
  if (intentHit) return;

  // EASTER EGGS
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

  // Run mystery first
  const mysteryHit = await handleMystery(message, content);
  if (mysteryHit) return;

  // AI FALLBACK
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
      } else {
        console.error('AI returned empty/null. Input was:', stripped);
        await message.reply('⚠️ I glitched trying to talk to OpenAI. Check server logs.').catch(()=>{});
      }
    } catch (e) {
      const safe = {
        name: e?.name,
        status: e?.status,
        code: e?.code,
        type: e?.type,
        message: e?.message,
        data: e?.response?.data,
      };
      console.error('OpenAI error detail:', safe);
      await message.reply(`⚠️ OpenAI call failed (${safe.status || 'no-status'}).`).catch(()=>{});
    }
    return;
  }

  // Catch-alls
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
