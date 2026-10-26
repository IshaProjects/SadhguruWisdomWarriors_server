# 🧘 Sadhguru Wisdom Warriors — YouTube Analytics Platform

Comprehensive documentation, architecture guide, deployment pipelines, access credentials, and operational workflow for the **Sadhguru Wisdom Warriors YouTube Tracking & Analytics Platform**.

---

## 📖 1. Application Overview & Core Purpose

The **Sadhguru Wisdom Warriors YouTube Analytics Platform** is a specialized, automated intelligence system built to track, measure, and analyze the collective reach of the Sadhguru Wisdom Warriors initiative across hundreds of creator channels worldwide.

### What the Application Does
1. **Automated Daily Metric Scraping & Sync:**
   * Every day at UTC midnight, an automated sync engine executes across all tracked YouTube channels.
   * It fetches live channel-level statistics (**subscriber count**, **total lifetime views**, **video count**).
   * It scans and syncs **every individual video** on every channel, recording its live **view count**, **likes**, and **comments**.
2. **Daily Snapshot History Engine:**
   * Raw YouTube data only provides cumulative lifetime view counts. To solve this, our system records a daily snapshot (`ChannelSnapshot` and `VideoSnapshot`) for every channel and video.
   * This enables exact **period-based performance analysis** (e.g., how many *exact views* were generated in August vs. September), tracking true momentum rather than just cumulative counters.
3. **Channel Rebranding & Handle Preservation:**
   * Creators frequently update their channel names and `@handles` on YouTube.
   * The daily sync automatically detects name or handle changes from YouTube's API, updates the channel profile, and preserves previous names in notes (e.g., *"Formerly: Truth Unmasked"*), ensuring channels remain searchable by both old and new names.

---

## 🏷️ 2. Channel Segmentation: Dedicated vs. IHI Channels

To ensure reporting integrity, channels are separated into two distinct operational pipelines with specific classification rules:

```
                          Tracked YouTube Channels
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           ▼                                                   ▼
 🟢 Dedicated Channels                               🟡 IHI Channels (Mixed Content)
 - Sourced from Dedicated Sheet                      - Sourced from IHI Master Database
 - 100% Sadhguru content                              - Mixed content (Yoga, Vlogs, Lifestyle)
 - Auto-marked with Green Checkmark (✓)              - Marked with Dash (—)
 - 100% videos & views count directly                - Every video evaluated via Gemini AI
                                                       • Sadhguru Video ──► Included in Reach
                                                       • Non-Sadhguru   ──► Excluded from Reach
```

### A. Dedicated Channels (100% Sadhguru Focus)
* **Definition:** Channels created exclusively for sharing Sadhguru’s wisdom, talks, discourses, and Isha initiatives.
* **Classification Rule:**
  * **100% of videos are Sadhguru content.**
  * No per-video filtering is required.
  * Automatically assigned the **green checkmark (`✓`)** in the `Classified` dashboard column upon sync.
  * 100% of their views, uploads, and engagement contribute directly to the platform's campaign analytics.

### B. IHI Channels (In-House Influencers / Mixed Content Creators)
* **Definition:** Channels run by Isha Hatha Yoga (IHI) teachers, volunteers, or independent creators who post diverse content genres (Hatha Yoga, wellness, nutrition, travel, personal vlogs) alongside occasional Sadhguru content.
* **Classification Rule:**
  * Displays a **dash (`—`)** in the dashboard classification column.
  * **Automated AI Content Classification:** Every fresh video ingested from an IHI channel is evaluated through intelligent keyword filters and **Google Gemini AI classification**:
    * **`sadhguru` content:** Included in the campaign's aggregated views and reach.
    * **`non sadhguru` content:** Excluded from the campaign analytics so that personal or non-relevant videos do not skew reporting.

---

## 📊 3. Analytics & Intelligence Capabilities

* **Period Views Delta Calculation:** Evaluates exact opening and closing snapshot views to determine true view gains within any calendar month.
* **New Uploads vs. Catalog Reach:** Distinguishes between views driven by fresh monthly uploads versus older evergreen videos (catalog/backlog) continuing to accumulate algorithmic views.
* **80/20 Pareto Distribution:** Identifies the vital few channels and videos (typically ~6% of channels and ~1.2% of videos) that generate 80%+ of total platform viewership.

---

## 📌 4. Repositories & Live Deployments

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

## 🗄️ 5. Database Access (Supabase PostgreSQL)

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

## 📑 6. Google Sheets Integration & Category Mapping

The app continuously synchronizes channels from two live Google Sheets:

### A. Dedicated Master Database
* **Spreadsheet ID:** `1rF7tGOjn5gdEWnn3DEwao51wPvDIf2xLgD_WJk47xA0`
* **Tabs & Category Mapping:**
  * `Grade A` $\rightarrow$ `Dedicated - Grade A`
  * `Grade B` $\rightarrow$ `Dedicated - Grade B`
  * `Grade C` $\rightarrow$ `Dedicated - Grade C`
  * `Grade D` $\rightarrow$ `Dedicated - Grade D`
  * `Grade E` $\rightarrow$ `Dedicated - Grade E`
  * `Inactive` $\rightarrow$ `Dedicated - Inactive`

### B. IHI Master Database (In-House Influencer / Mixed Channels)
* **Spreadsheet ID:** `1J027IUUkk6wWvbactK6qgRwYUWoEafIxIScQwiDq1BU`
* **Tabs & Category Mapping:**
  * `Grade A` $\rightarrow$ `IHI - Grade A`
  * `Grade B` $\rightarrow$ `IHI - Grade B`
  * `Grade C` $\rightarrow$ `IHI - Grade C`
  * `Grade D` $\rightarrow$ `IHI - Grade D`
  * `Grade E` $\rightarrow$ `IHI - Grade E`
  * `Inactive` $\rightarrow$ `IHI - Inactive`

---

## 🤖 7. Automated AI Deployment (CI/CD Pipeline)

Deployments are fully automated through GitHub integration:

```
Developer / AI Assistant pushes code to GitHub (main branch)
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
 Vercel (Frontend)              DigitalOcean (Backend)
 - Detects commit on `main`     - Detects commit on `main`
 - Runs `npm run build`         - Runs `npx prisma generate`
 - Live in ~60 seconds          - Runs `npm start`
                                - Live in ~120 seconds
```

---

## ⚙️ 8. Environment Variables Reference

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

## ⏰ 9. Automated Background Cron Schedules

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

## 💻 10. How to Run Locally (Optional / Development)

If you or an engineer ever want to test changes on a local machine before pushing to production:

### Prerequisites
* Node.js 18+ or 20+
* Git & npm

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
