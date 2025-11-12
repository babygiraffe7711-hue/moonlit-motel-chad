// Chad — Moonlit Motel bot (complete, fixed)
// Features: lore + mystery stages + roasts + fortunes + ambient + gaslight/unhinged +
//           random facts + time + weather + basement/NSFW + jail helpers + role reward
// Works on Render (Background Worker). Persists state to /data if disk exists, else local file.

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

// ---------- CONFIG ----------
const TZ  = process.env.TIMEZONE || 'America/Winnipeg';
const OWM = process.env.OPENWEATHER_API_KEY || null; // OpenWeather API key (optional for weather)

// Prefer /data if mounted (Render disk). Else local file (ok for free tier)
const STATE_DIR  = fs.existsSync('/data') ? '/data' : path.resolve('./');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

// ----- SINGLETON LOCK (prevents 2 workers replying twice) -----
const LOCK_PATH = path.join(STATE_DIR, 'chad.lock');
try {
  const fd = fs.openSync(LOCK_PATH, 'wx'); // fail if file already exists
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

// Load brain + state
let brain = loadJSON('./brain.json', {
  roast_pool: ["default roast line"],
  fortunes: ["default fortune"],
  ambient: ["ambient line"],
  stages: []
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
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Using state path: ${STATE_PATH}`);
  console.log(`Stages loaded: ${(brain.stages || []).length}`);
  console.log(`Ambient lines: ${(brain.ambient || []).length}`);
  console.log(`Roasts: ${(brain.roast_pool || []).length}`);

  // Ambient: drop a random line every ~3 hours
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
        await chan.send(line);
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
  const start = now.set({ hour: sh, minute: sm, second: 0 });
