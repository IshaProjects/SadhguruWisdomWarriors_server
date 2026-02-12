# Deploy Server to Digital Ocean (App Platform)

## 1. Push code to GitHub

Ensure the server code is in **IshaProjects/SadhguruWisdomWarriors_server** (or your server repo).

## 2. Create App in Digital Ocean

1. Go to [cloud.digitalocean.com](https://cloud.digitalocean.com) → **Apps** → **Create App**.
2. Choose **GitHub** and authorize if needed.
3. Select **SadhguruWisdomWarriors_server** (or your server repo).
4. Pick the **main** branch.
5. Digital Ocean will detect a Node.js app. Confirm:
   - **Source Directory:** leave empty (repo root is the server).
   - **Build Command:** `npm install` (or leave default).
   - **Run Command:** `npm start` (runs `node src/app.js`).

## 3. Environment variables

In the App → **Settings** → **App-Level Environment Variables** (or Component env vars), add:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (DO sets it) | App Platform sets this; you can omit or set to match. |
| `NODE_ENV` | Recommended | Set to `production`. |
| `MONGODB_URI` | **Yes** | MongoDB connection string (can include or omit database name). |
| `MONGODB_DB_NAME` | No | Database name. Overrides DB in URI. Use different names per environment (e.g. `yt_dashboard_prod`). |
| `JWT_SECRET` | **Yes** | Long random string for access tokens. |
| `JWT_REFRESH_SECRET` | **Yes** | Long random string for refresh tokens. |
| `JWT_EXPIRE` | No | e.g. `15m`. |
| `JWT_REFRESH_EXPIRE` | No | e.g. `7d`. |
| `YOUTUBE_API_KEY` | **Yes** | For channel/sync features. |
| `DAILY_QUOTA_LIMIT` | No | e.g. `10000`. |
| `SYNC_CRON_SCHEDULE` | No | e.g. `0 3 * * *` (3 AM daily). |

Use **Encrypted** for secrets. Copy from your local `server/.env` (never commit `.env`).

**Different databases per environment:** Use a different `MONGODB_URI` and/or `MONGODB_DB_NAME` per environment (e.g. local `.env` → `yt_dashboard_dev`, production on DO → `yt_dashboard_prod`) so dev and prod data stay separate.

## 4. Deploy

Click **Next** through resources (default 1 container is fine) and **Create Resources**. Digital Ocean will build and deploy. Note the app URL (e.g. `https://your-app-xxxxx.ondigitalocean.app`).

## 5. CORS (if needed)

The server uses `cors()`. If your Vercel domain is rejected, in `server/src/app.js` you can restrict origin:

```js
app.use(cors({ origin: ['https://your-vercel-app.vercel.app'] }));
```

Or keep `cors()` open for development and tighten later.

## 6. Use this URL in the client

In Vercel, set the client env var:

**VITE_API_BASE_URL** = `https://your-app-xxxxx.ondigitalocean.app/api`

Then redeploy the client so it uses the production API.
