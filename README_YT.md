# 🧘 Sadhguru Wisdom Warriors — YouTube Analytics Platform

Comprehensive documentation, architecture guide, deployment pipelines, access credentials, and autonomous deployment protocols for the **Sadhguru Wisdom Warriors YouTube Tracking & Analytics Platform**.

---

## ⚡ 1. Autonomous AI Agent Protocol (Auto-Deploy Directive)

> **Official Project Directive:**  
> The AI Assistant / Developer is **authorized to execute end-to-end changes autonomously**. Whenever new channels, features, bug fixes, or synchronization logic are requested:
> 1. **Modify & Test:** Apply code changes and verify syntax (`node -c`) and production builds (`npm run build`) locally.
> 2. **Auto-Commit & Push:** Automatically commit changes and push directly to GitHub (`origin/main`) without pausing for manual approval.
> 3. **Auto-Deploy Live:** The GitHub push automatically triggers:
>    * **Vercel** $\rightarrow$ Rebuilds and deploys the Frontend UI in ~60 seconds.
>    * **DigitalOcean** $\rightarrow$ Rebuilds and deploys the Backend Server in ~120 seconds.
> 4. **Database Direct Operations:** Read, query, sync, and update the **Supabase PostgreSQL** database directly using the pooler connection strings below.

---

## 📌 2. Repositories & Live Deployments

### Source Code Repositories
* **Backend API Server (Node.js / Express / Prisma):**  
  👉 [https://github.com/IshaProjects/SadhguruWisdomWarriors_server](https://github.com/IshaProjects/SadhguruWisdomWarriors_server)
* **Frontend Web App (React / Vite / Tailwind):**  
  👉 [https://github.com/IshaProjects/SadhguruWisdomWarriors](https://github.com/IshaProjects/SadhguruWisdomWarriors)

### Live Production Environments
* **Frontend Web Application (Vercel):**  
  🔗 [https://sadhguru-wisdom-warriors-mu.vercel.app/](https://sadhguru-wisdom-warriors-mu.vercel.app/)
* **Backend API Server (DigitalOcean App Platform):**  
  🔗 [https://seahorse-app-odhgd.ondigitalocean.app](https://seahorse-app-odhgd.ondigitalocean.app)
* **API Health Check Endpoint:**  
  🔗 [https://seahorse-app-odhgd.ondigitalocean.app/api/health](https://seahorse-app-odhgd.ondigitalocean.app/api/health)

---

## 🗄️ 3. Database Access (Supabase PostgreSQL)

The platform runs on a managed PostgreSQL cluster hosted on **Supabase** in Asia South 1 (Mumbai).

### Connection Details
* **Supabase Project Reference ID:** `vsxgzvduphqqcpwwrhzt`
* **Region / AWS Data Center:** `aws-1-ap-south-1` (Mumbai, India)
* **Database Name:** `postgres`
* **Default Database User:** `postgres` (direct) / `postgres.vsxgzvduphqqcpwwrhzt` (pooler)

### Connection Strings

#### 1. Node.js Backend / Prisma ORM (Port 6543 - Transaction Pooler with PgBouncer)
Used by the backend server for fast concurrent database requests:
```text
DATABASE_URL="postgresql://postgres.vsxgzvduphqqcpwwrhzt:[DATABASE_PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
```

#### 2. Prisma Migrations / Direct Session Connection (Port 5432)
Used for schema migrations (`prisma db push` / `prisma migrate`) and administrative scripts:
```text
DIRECT_URL="postgresql://postgres.vsxgzvduphqqcpwwrhzt:[DATABASE_PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres"
```

#### 3. Python / asyncpg Connection String (Port 6543 / 5432)
Used for automated data analytics, exports, and research scripts:
```text
postgresql+asyncpg://postgres.vsxgzvduphqqcpwwrhzt:[DATABASE_PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:6543/postgres
```

---

## 📑 4. Google Sheets Integration & Category Mapping

The app continuously synchronizes channels from two live Google Sheets:

### A. Dedicated Master Database
* **Spreadsheet ID:** `1rF7tGOjn5gdEWnn3DEwao51wPvDIf2xLgD_WJk47xA0`
* **Classification Rule:** Dedicated channels publish 100% Sadhguru content and always receive a **green checkmark (`✓`)** in the Classified column.
* **Tabs & Category Mapping:**
  * `Grade A` $\rightarrow$ `Dedicated - Grade A`
  * `Grade B` $\rightarrow$ `Dedicated - Grade B`
  * `Grade C` $\rightarrow$ `Dedicated - Grade C`
  * `Grade D` $\rightarrow$ `Dedicated - Grade D`
  * `Grade E` $\rightarrow$ `Dedicated - Grade E`
  * `Inactive` $\rightarrow$ `Dedicated - Inactive`

### B. IHI Master Database (In-House Influencer / Mixed Channels)
* **Spreadsheet ID:** `1J027IUUkk6wWvbactK6qgRwYUWoEafIxIScQwiDq1BU`
* **Classification Rule:** IHI channels publish mixed content and receive a **dash (`—`)** until individual videos are analyzed and classified by the Vertex AI / Gemini engine.
* **Tabs & Category Mapping:**
  * `Grade A` $\rightarrow$ `IHI - Grade A`
  * `Grade B` $\rightarrow$ `IHI - Grade B`
  * `Grade C` $\rightarrow$ `IHI - Grade C`
  * `Grade D` $\rightarrow$ `IHI - Grade D`
  * `Grade E` $\rightarrow$ `IHI - Grade E`
  * `Inactive` $\rightarrow$ `IHI - Inactive`

---

## ⚙️ 5. Environment Variables Reference

### Backend (`.env` on DigitalOcean)
| Variable | Value / Description |
| :--- | :--- |
| `NODE_ENV` | `production` |
| `PORT` | `8080` |
| `DATABASE_URL` | Supabase pooler URL (Port `6543` with `?pgbouncer=true`) |
| `DIRECT_URL` | Supabase direct URL (Port `5432`) |
| `JWT_SECRET` | Secret key for access token signing |
| `JWT_REFRESH_SECRET`| Secret key for refresh token signing |
| `JWT_EXPIRE` | `15m` |
| `JWT_REFRESH_EXPIRE`| `7d` |
| `YOUTUBE_API_KEY` | Google YouTube Data API v3 key |
| `DAILY_QUOTA_LIMIT` | `10000` |
| `SYNC_CRON_SCHEDULE`| `0 3 * * *` |
| `GEMINI_API_KEY` | Google Gemini API key for automated AI classification |

### Frontend (`.env` / Vercel Environment Variables)
| Variable | Value / Description |
| :--- | :--- |
| `VITE_API_BASE_URL` | `https://seahorse-app-odhgd.ondigitalocean.app/api` |

---

## ⏰ 6. Automated Background Cron Schedules

The backend runs automated background cron jobs:
* **Channel Sync (`0 3 * * *` — 3:00 AM UTC / 8:30 AM IST Daily):**
  * Fetches latest subscriber count, total views, and video counts from YouTube.
  * Auto-updates renamed channel titles and handles (preserving previous names in notes).
  * Stores daily `ChannelSnapshot` records.
* **Dedicated Video Sync (`0 4 * * *` — 4:00 AM UTC Daily):**
  * Pulls latest views, likes, and comments for dedicated channel videos.
  * Creates daily `VideoSnapshot` records.
* **Dedicated Video Ingestion (`0 0 * * *` — 12:00 AM UTC Daily):**
  * Checks for fresh videos published in the last 24 hours.
* **IHI Ingest & AI Classification (`0 */6 * * *` — Every 6 Hours):**
  * Ingests new videos published on IHI channels.
  * Sends title and description to Gemini AI to classify as `'sadhguru'` or `'non sadhguru'`.

---

## 💻 7. How to Run Locally (Optional / Development)

If you or an engineer ever want to test changes on a local machine before pushing to production:

### Prerequisites
* Node.js 18+ or 20+
* Git
* npm

### Step 1: Run the Backend
```bash
cd SadhguruWisdomWarriors_server
npm install
npx prisma generate
npm run dev
# Server runs on http://localhost:8080
```

### Step 2: Run the Frontend
```bash
cd SadhguruWisdomWarriors_frontend
npm install
npm run dev
# Frontend runs on http://localhost:5173
```

---

## 🛡️ 8. Security & Best Practices
* **GitHub Tokens:** Always use a classic GitHub Personal Access Token with the `repo` scope to authorize pushes.
* **Never commit real database passwords** or raw API keys in public repositories; always inject them as environment variables in DigitalOcean App Platform and Vercel.
* **Prisma Pooler:** When connecting from serverless environments or background jobs, always connect through port `6543` to avoid exhausting database connection limits.
