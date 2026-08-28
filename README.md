# Ping Pong VIP — full-stack app

This is a real client + server app:

- **`server.js`** — Node.js/Express backend. Real accounts (bcrypt-hashed passwords),
  JWT login sessions, a SQLite database, a REST API, an admin API, and a
  Socket.io layer for real-time online matchmaking.
- **`public/index.html`** — the game itself (single file: HTML/CSS/JS + canvas
  game engine). It talks to the backend over `fetch()` and WebSockets, and
  also caches your latest save in the browser's `localStorage` so the game
  loads instantly and keeps working for a bit if your connection drops.

You (the person deploying it) are the **owner/admin**. Whoever registers with
a username listed in `ADMIN_USERNAMES` automatically gets an admin account
with access to an in-app **Admin** tab (grant coins/gems, ban/unban accounts,
view all accounts).

---

## 1. Run it on your own computer first (recommended)

You'll need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd pingpong-vip-app
npm install
cp .env.example .env
```

Open `.env` and set two things:

```
JWT_SECRET=<paste a long random string here>
ADMIN_USERNAMES=<your future username, lowercase>
```

Generate a good secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then start the server:

```bash
npm start
```

Open **http://localhost:3000** in your browser, click "Create Account," and
register using the exact username you put in `ADMIN_USERNAMES` — that account
will automatically have admin rights (look for the new **Admin** tab in the
bottom nav).

---

## 2. Put the code on GitHub

1. Create a new repository on [github.com](https://github.com) (e.g. `pingpong-vip`).
2. In the `pingpong-vip-app` folder:
   ```bash
   git init
   git add .
   git commit -m "Ping Pong VIP"
   git branch -M main
   git remote add origin https://github.com/<your-username>/pingpong-vip.git
   git push -u origin main
   ```

Note: `data.sqlite` (your database file) and `.env` (your secrets) are listed
in `.gitignore` so they won't be pushed — that's intentional, don't remove
that.

---

## 3. Deploy the backend + frontend together (one service)

Because the server also serves `public/index.html`, you only need **one**
hosted service — you don't need to deploy the frontend separately.

### Option A — Render.com (free tier available, easiest)

1. Go to [render.com](https://render.com) → New → **Web Service**.
2. Connect your GitHub repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Under **Environment**, add:
   - `JWT_SECRET` → your long random string
   - `ADMIN_USERNAMES` → your username
5. Under **Disks**, add a persistent disk (e.g. 1 GB, mount path `/data`), then
   add one more env var: `DB_PATH=/data/data.sqlite`. This keeps your accounts
   safe across deploys/restarts — without it, Render's free filesystem is
   wiped on every redeploy and everyone's progress would be lost.
6. Click **Create Web Service**. Render gives you a live URL like
   `https://pingpong-vip.onrender.com` — that's your real, public website.

### Option B — Railway.app

Same idea: New Project → Deploy from GitHub → add the same environment
variables → attach a volume mounted at `/data` → set `DB_PATH=/data/data.sqlite`.

### Option C — Your own VPS (DigitalOcean, Linode, etc.)

```bash
git clone <your repo>
cd pingpong-vip-app
npm install
JWT_SECRET=... ADMIN_USERNAMES=... npm start
```
Put it behind Nginx + a process manager like `pm2` and point a domain at it
for a permanent, always-on setup.

---

## 4. On-device storage (what you asked about)

Two layers are already built in:

- **Server database** (`data.sqlite` / `DB_PATH`) — the source of truth.
  Every match result, purchase, and XP gain is saved here so a player's
  account is the same on any device they log into.
- **Browser `localStorage`** — every time the game saves, it also writes a
  copy straight onto the player's device. That's what makes the game open
  instantly next time and keeps showing a cached profile for a little while
  even without a network connection. This is genuinely stored **on the
  user's device**, unlike the previous version.

There's no extra "permission" step needed for `localStorage` — it's on by
default in every modern browser for any site the player visits, unlike
things like camera/microphone access.

---

## 5. Becoming admin / managing the app

- Add your username to `ADMIN_USERNAMES` **before** you register that account.
  (If you already registered without it, add the env var, restart the
  server, then call the admin API once manually, or just re-add yourself via
  the database — ask if you want a one-off script for this.)
- Log in normally — you'll see a new **Admin** tab in the bottom navigation.
- From there you can grant coins/gems to any account and ban/unban players.

---

## 6. Honest limitations of this build (so nothing surprises you)

- **Payments are simulated.** The Shop/VIP screens use in-game currency only.
  To take real money you'd need to integrate a real processor (Stripe,
  Google Play Billing, Apple In-App Purchase) with **server-side receipt
  verification** — that's a separate integration on top of this codebase,
  since it requires your own merchant/developer accounts.
- **Online multiplayer** uses a lightweight Socket.io relay: the "host"
  player's browser runs the physics and the other player's browser mirrors
  it. This works well for casual real-time play but isn't a dedicated
  authoritative game server — for large-scale competitive play you'd
  eventually want server-authoritative physics.
- **Anti-cheat** here is basic (server clamps unrealistic currency/rating
  jumps on save). A production title would validate full match replays
  server-side.

If you want, I can help you build any of the above out further — including a
real payment integration, a dedicated authoritative match server, or a
proper admin dashboard.
