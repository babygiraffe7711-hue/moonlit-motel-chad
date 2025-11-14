// guestbook.js
// Simple guest memory system for the Moonlit Motel (Chad).

const fs = require("fs");
const path = require("path");

const GUESTBOOK_PATH = path.join(__dirname, "guestbook.json");

function loadGuestbook() {
  try {
    const raw = fs.readFileSync(GUESTBOOK_PATH, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.warn("[guestbook] starting fresh:", err.message);
    return {};
  }
}

let guestbook = loadGuestbook();

function saveGuestbook() {
  try {
    fs.writeFileSync(GUESTBOOK_PATH, JSON.stringify(guestbook, null, 2), "utf8");
  } catch (err) {
    console.error("[guestbook] failed to write guestbook.json:", err);
  }
}

/**
 * Record a message from a user.
 * `userLike` can be a GuildMember or a User.
 *
 * Returns: { guest, isNew }
 */
function touchGuest(userLike) {
  if (!userLike) return { guest: null, isNew: false };

  const id = userLike.id;
  const name = userLike.displayName || userLike.username || "Unknown Guest";
  const now = new Date().toISOString();

  if (!id) return { guest: null, isNew: false };

  if (!guestbook[id]) {
    guestbook[id] = {
      id,
      name,
      firstSeen: now,
      lastSeen: now,
      messageCount: 1
    };
    saveGuestbook();
    return { guest: guestbook[id], isNew: true };
  } else {
    const g = guestbook[id];
    g.name = name;
    g.lastSeen = now;
    g.messageCount = (g.messageCount || 0) + 1;
    saveGuestbook();
    return { guest: g, isNew: false };
  }
}

function getGuest(id) {
  return guestbook[id];
}

function getGuestbook() {
  return guestbook;
}

module.exports = {
  touchGuest,
  getGuest,
  getGuestbook
};
