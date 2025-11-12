// index.js (utility + mystery + lore)
// — adds time, weather, random fact; keeps your full logic

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

const TZ = process.env.TIMEZONE || 'America/New_York';
const OWM = process.env.OPENWEATHER_API_KEY || null; // <-- add this in Render if you want weather

// prefer /data if mounted (paid disk), else local file (free tier)
const STATE_DIR = fs.existsSync('/data') ? '/data' : path.resolve('./');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

// ---- load/save helpers ----
const loadJSON = (p, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
};
const saveJSON = (p, obj) => {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
};

let brain = loadJSON('./brain.json');
let state = loadJSON(STATE_PATH, {});

// ---------- discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Using state path: ${STATE_PATH}`);

  // Ambient: drop a random line every ~3 hours
  setInterval(async () => {
    if (!brain.ambient || !brain.ambient.length) return;
    for (const [gid] of client.guilds.cache) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const chan = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased?.() && c.viewable);
      if (!chan) continue;
      if (Math.random() < 0.35) {
        const line = pick(brain.ambient);
        await chan.send(line);
      }
    }
  }, 1000 * 60 * 60 * 3);
});

// ---------- small utils ----------
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const getGuildState = (guildId) => {
  if (!state[guildId]) {
    state[guildId] = { stage: 1, gates: {}, cooldowns: {}, participants: {} };
    saveJSON(STATE_PATH, state);
  }
  return state[guildId];
};
const nowInWindow = (sh, sm, eh, em) => {
  const now = DateTime.now().setZone(TZ);
  const start = now.set({ hour: sh, minute: sm, second: 0 });
  const end   = now.set({ hour: eh, minute: em, second: 0 });
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

// Very small place→timezone helper for common motel locales
const tzAlias = (name) => {
  const s = (name || '').toLowerCase().trim();
  if (!s) return TZ;
  if (/(brandon|manitoba|winnipeg|mb|prairies)/i.test(name)) return 'America/Winnipeg';
  if (/new york|nyc|eastern/i.test(name)) return 'America/New_York';
  if (/la|los angeles|pacific/i.test(name)) return 'America/Los_Angeles';
  if (/london|uk|gmt|britain/i.test(name)) return 'Europe/London';
  return TZ; // fallback to server TZ
};

// ---------- roast homage ----------
const roastRegex = /(sts\b|over[-\s]?polic|too many rules|north\s*korea|rule\s*police)/i;
async function maybeRoast(message, gState) {
  if (!roastRegex.test(message.content)) return;
  if (hasDailyCooldown(gState, 'roast_daily')) return;
  const pool = brain.roast_pool || [];
  if (!pool.length) return;
  await message.reply(pick(pool));
  setDailyCooldown(gState, 'roast_daily');
}

// ---------- role/channel helpers ----------
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

// ---------- hints ----------
async function maybeHint(message, gState, stageObj) {
  if (!stageObj.hints || !stageObj.hints.length) return;
  const key = `hint_${gState.stage}`;
  if (hasDailyCooldown(gState, key)) return;
  if (/^chad[, ]/i.test(message.content)) {
    await message.channel.send(pick(stageObj.hints));
    setDailyCooldown(gState, key);
  }
}

// ---------- mystery engine ----------
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
      gState.gates.s6 = { sequence: [], done: false };
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

// ---------- utilities: time / weather / facts ----------
function formatTime(zone) {
  const now = DateTime.now().setZone(zone || TZ);
  const nice = now.toFormat("ccc, LLL d 'at' h:mm a");
  return `🕰️ ${nice} (${zone})`;
}
async function fetchWeather(qRaw) {
  if (!OWM) return { err: "Weather not set up. Ask the Innkeeper to add OPENWEATHER_API_KEY." };
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

// ---------- message & reactions ----------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const gState = getGuildState(message.guild.id);
  gState.participants[message.author.id] = true;

  // roast homage
  await maybeRoast(message, gState);

  const content = message.content;

  // ask the motel
  if (/^chad,\s*ask the motel\b/i.test(content)) {
    const pool = brain.fortunes || [];
    if (pool.length) { await message.reply(pick(pool)); return; }
  }

  // random fact
  if (/^chad,\s*(random fact|fact)$/i.test(content)) {
    await message.reply(`📎 ${randomFact()}`);
    return;
  }

  // time: chad, time | chad, time in <place>
  const timeMatch = content.match(/^chad,\s*time(?:\s+in\s+(.+))?$/i) || content.match(/^chad,\s*what(?:'s| is)\s+the\s+time(?:\s+in\s+(.+))?$/i);
  if (timeMatch) {
    const place = timeMatch[1];
    const zone = tzAlias(place);
    await message.reply(formatTime(zone));
    return;
  }

  // weather: chad, weather | chad, weather in <city>
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
      } else if (egg.responses && egg.responses.length) {
        await message.reply(pick(egg.responses));
      }
      return;
    }
  }

  // mystery routing (after collectors below)
  // ---- stage 3 confession collector (5 unique)
  if (gState.stage === 4 && gState.gates.s3) {
    delete gState.gates.s3; saveJSON(STATE_PATH, state);
  } else if (gState.stage === 3 && gState.gates.s3) {
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

  // ---- stage 6 pattern (3 confessions + 3 jokes alternating)
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

  // ---- stage 7 (apology + forgiveness at 3:03–3:10 a.m.)
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

  // finally, route to stage triggers & responses
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
