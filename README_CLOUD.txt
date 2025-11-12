
CLOUD HOSTING QUICK START (Render / Railway)
============================================

1) Push this folder to GitHub (do NOT include your real .env).
2) Create a new Web Service from the repo.
3) Set Environment Variables:
   - DISCORD_TOKEN=your_bot_token
   - TIMEZONE=America/Winnipeg
4) Add a Persistent Disk/Volume:
   - Mount Path: /data
   - Size: 1 GB
5) Build & Start. The service runs `npm install` then `npm start`.
6) Invite the bot to your server with the OAuth2 URL you generated.

Note: State is saved to /data/state.json so your mystery progress survives redeploys.
