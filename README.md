# Sadhguru Wisdom Warriors — YouTube Tracking & Analytics Platform
### Autonomous AI Handover, Architecture & Deployment Masterfile

> **Note for AI Coding Assistants (Claude / GPT / Antigravity):**  
> This file is the single source of truth for the entire Wisdom Warriors YouTube application ecosystem. It contains repository links, Supabase database connections, deployment pipelines, architectural patterns, database schemas, and step-by-step instructions to implement and deploy any new feature directly to production.

---

## 1. 🌟 Live Application Links & Repositories

| Component | Repository Link | Production Deployment | Hosting Provider |
| :--- | :--- | :--- | :--- |
| **Frontend Web App** | [IshaProjects/SadhguruWisdomWarriors](https://github.com/IshaProjects/SadhguruWisdomWarriors) | `https://sadhguru-wisdom-warriors-mu.vercel.app` | **Vercel** (Auto-deploys on `main` push) |
| **Backend API Server** | [IshaProjects/SadhguruWisdomWarriors_server](https://github.com/IshaProjects/SadhguruWisdomWarriors_server) | `https://seahorse-app-odhgd.ondigitalocean.app` | **DigitalOcean App Platform** (Auto-deploys on `main` push) |
| **PostgreSQL Database** | Managed Supabase Instance | Region: `aws-1-ap-south-1` (Mumbai) | **Supabase** |

---

## 2. 🗄️ Supabase Database Connection & Access

### Database Credentials & Connection Strings:
* **Supabase Project Reference:** `vsxgzvduphqqcpwwrhzt`
* **Direct Database Host (Port 5432):** `db.vsxgzvduphqqcpwwrhzt.supabase.co:5432`
* **Connection Pooler Host (Port 6543 / 5432):** `aws-1-ap-south-1.pooler.supabase.com`
* **Database Name:** `postgres`
* **Default Database User:** `postgres.vsxgzvduphqqcpwwrhzt`

#### A. Node.js / Prisma Production Pooler (Port 6543 - Transaction Mode):
```env
DATABASE_URL="postgresql://postgres.vsxgzvduphqqcpwwrhzt:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
```
*(Used in runtime by Express server to prevent connection exhaustion).*

#### B. Direct Session Connection (Port 5432 - For Migrations / Python asyncpg):
```env
DIRECT_URL="postgresql://postgres.vsxgzvduphqqcpwwrhzt:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres"
```

#### C. Python asyncpg Connection Format:
```python
import asyncpg
conn = await asyncpg.connect(
    user='postgres.vsxgzvduphqqcpwwrhzt',
    password='[PASSWORD]',
    database='postgres',
    host='aws-1-ap-south-1.pooler.supabase.com',
    port=6543,
    ssl='require',
    statement_cache_size=0
)
```

---

## 3. 🛠️ Tech Stack & Key Files Map

### Backend (`SadhguruWisdomWarriors_server`)
* **Runtime:** Node.js (v18+) with ES Modules (`import/export`).
* **Framework:** Express.js, Prisma ORM (`@prisma/client`), `node-cron`.
* **Key Files:**
  * `src/server.js`: Server entrypoint, Express middleware, cron schedules initialization.
  * `src/config/prisma.js`: Prisma client instance.
  * `prisma/schema.prisma`: Database models definition.
  * `src/controllers/channelController.js`: Channel CRUD, universal search, category filtering, rename auto-update logic.
  * `src/controllers/dashboardController.js`: Aggregated KPIs, growth metrics, reach calculations.
  * `src/services/googleSheetSync.js`: Dual Google Sheets parser, YouTube handle resolution, batch deduplication, bulk importer.
  * `src/services/syncEngine.js`: Background daily sync jobs, YouTube Data API batching, snapshot recording.
  * `src/utils/helpers.js`: `serializeChannel` (BigInt JSON serializer), `extractChannelId`, YouTube stat parsers.

### Frontend (`SadhguruWisdomWarriors`)
* **Framework:** React 18, Vite, Tailwind CSS, Lucide Icons, Axios.
* **Key Files:**
  * `src/services/api.js`: Axios instance with JWT auth interceptors and `baseURL: import.meta.env.VITE_API_BASE_URL || '/api'`.
  * `src/pages/Channels.jsx`: Main channel dashboard with group tabs (`[All]`, `[Dedicated]`, `[IHI]`), search bar, category dropdown, bulk actions.
  * `src/components/channels/GoogleSheetSyncModal.jsx`: Modal to preview and approve channel syncs with dedicated tab switcher (`Dedicated Sheet` vs `IHI Master Database`).
  * `src/components/channels/AddChannelModal.jsx`: Add single channel modal with live handle rename detection and alias preservation.
  * `src/components/channels/ChannelTable.jsx`: Desktop channel rows table, displaying live titles, `(Formerly: X)` labels, and green checkmark / dash classification status.
  * `src/components/channels/ChannelCard.jsx`: Mobile card view for channels.

---

## 4. 📐 Database Schema Overview (Prisma Models)

```prisma
model Channel {
  id                 String            @id @default(uuid())
  youtubeChannelId   String            @unique
  title              String
  description        String?
  thumbnailUrl       String?
  bannerUrl          String?
  customUrl          String?           // @handle
  country            String?
  category           String            @default("Uncategorized")
  status             String            @default("active") // active, inactive, archived
  notes              String?           // Stores aliases (e.g. "Formerly: Truth Unmasked")
  tags               String[]          @default([])
  currentSubscribers Int               @default(0)
  currentViews       BigInt            @default(0)
  currentVideoCount  Int               @default(0)
  lastSyncedAt       DateTime?
  publishedAt        DateTime?         // Channel creation date on YouTube
  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt
  deletedAt          DateTime?

  snapshots          ChannelSnapshot[]
  videos             Video[]
  videoSnapshots     VideoSnapshot[]
}

model Video {
  id                 String            @id @default(uuid())
  youtubeVideoId     String            @unique
  channelId          String
  title              String
  description        String?
  publishedAt        DateTime?
  views              BigInt            @default(0)
  likes              Int               @default(0)
  comments           Int               @default(0)
  classification     String            @default("") // "sadhguru", "non sadhguru", or ""
  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt
  deletedAt          DateTime?

  channel            Channel           @relation(fields: [channelId], references: [id])
  snapshots          VideoSnapshot[]
}

model ChannelSnapshot {
  id          String   @id @default(uuid())
  channelId   String
  date        DateTime @db.Date
  subscribers Int      @default(0)
  views       BigInt   @default(0)
  videoCount  Int      @default(0)

  channel     Channel  @relation(fields: [channelId], references: [id])
  @@unique([channelId, date])
}

model VideoSnapshot {
  id         String   @id @default(uuid())
  videoId    String
  channelId  String
  date       DateTime @db.Date
  views      BigInt   @default(0)
  likes      Int      @default(0)
  comments   Int      @default(0)

  video      Video    @relation(fields: [videoId], references: [id])
  channel    Channel  @relation(fields: [channelId], references: [id])
  @@unique([videoId, date])
}
```

> **CRITICAL CODE CONVENTION:**
> PostgreSQL `BigInt` columns (`currentViews`, `views`) cannot be converted to JSON via standard `JSON.stringify()`. Always use `serializeChannel(ch)` or convert BigInts with `String(val)` or `Number(val)` before returning Express JSON responses.

---

## 5. 🎯 Core Business Logic & Rules

### A. Dedicated Channels vs. IHI Channels
1. **Dedicated Channels:**
   * Channels that post 100% Sadhguru content.
   * Categories: `Dedicated - Grade A`, `Dedicated - Grade B`, `Dedicated - Grade C`, `Dedicated - Grade D`, `Dedicated - Grade E`, `Dedicated - Inactive`.
   * **Classification Status:** Always marked as completed with a **green checkmark (`✓`)** in the dashboard (`classificationDone: true`).
2. **IHI (In-House Influencer / Mixed) Channels:**
   * Channels that post mixed lifestyle/yoga content alongside Sadhguru content.
   * Categories: `IHI - Grade A`, `IHI - Grade B`, `IHI - Grade C`, `IHI - Grade D`, `IHI - Grade E`, `IHI - Inactive`.
   * **Classification Status:** Always marked with a **dash (`—`)** (`classificationDone: false`) until individual videos are classified by the Gemini AI classifier.
3. **Tab Filtering Isolation:**
   * Filter `group=dedicated` strictly queries `where.category = { startsWith: 'Dedicated' }`.
   * Filter `group=ihi` strictly queries `where.category = { contains: 'IHI' }`.

### B. Google Sheets Sync Engine
* **Dedicated Sheet ID:** `1rF7tGOjn5gdEWnn3DEwao51wPvDIf2xLgD_WJk47xA0`
* **IHI Sheet ID:** `1J027IUUkk6wWvbactK6qgRwYUWoEafIxIScQwiDq1BU`
* **Scanning Logic:** Scans all cells across 6 tabs (`Grade A` through `Grade E` + `Inactive`). Extracts YouTube links matching handles, `UC...`, and custom URLs. Discards Instagram and text.
* **Auto-Rename Detection:** If YouTube channel was renamed (e.g. *Truth Unmasked* $\rightarrow$ *Its Meera*), the system detects the permanent `UC...` ID, updates `title` and `customUrl` to the live name, and records `"Formerly: Truth Unmasked"` into the `notes` field.
* **Universal Search:** Searching by current name, old name, `@handle`, full URL, or `UC...` ID always resolves the channel.

---

## 6. 🚀 Direct Deployment Instructions (For AI & Developers)

Both repositories are configured with **continuous deployment on `git push origin main`**:

### Deploying Backend Changes:
1. Make your code changes in `SadhguruWisdomWarriors_server`.
2. Check JavaScript syntax:
   ```bash
   node -c src/controllers/channelController.js src/services/syncEngine.js
   ```
3. Commit and push to GitHub:
   ```bash
   git commit -a -m "feat: your feature description"
   git push origin main
   ```
4. **DigitalOcean App Platform** automatically triggers a build:
   * Build Command: `npx prisma generate`
   * Run Command: `npm start`
   * Port: `8080`
   * Health Check: `/api/health`
   * Live in ~60 seconds at `https://seahorse-app-odhgd.ondigitalocean.app`

### Deploying Frontend Changes:
1. Make your code changes in `SadhguruWisdomWarriors`.
2. Test production build locally:
   ```bash
   npm run build
   ```
3. Commit and push to GitHub:
   ```bash
   git commit -a -m "feat: your feature description"
   git push origin main
   ```
4. **Vercel** automatically builds and deploys to production:
   * Build Command: `vite build`
   * Output Directory: `dist`
   * Live in ~30 seconds at `https://sadhguru-wisdom-warriors-mu.vercel.app`

---

## 7. 🔐 Environment Variables Checklist

### Backend `.env` (DigitalOcean App Platform)
```env
NODE_ENV=production
PORT=8080
DATABASE_URL="postgresql://postgres.vsxgzvduphqqcpwwrhzt:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.vsxgzvduphqqcpwwrhzt:[PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres"
JWT_SECRET=[SECRET]
JWT_REFRESH_SECRET=[SECRET]
JWT_EXPIRE=15m
JWT_REFRESH_EXPIRE=7d
YOUTUBE_API_KEY=[API_KEY]
DAILY_QUOTA_LIMIT=10000
SYNC_CRON_SCHEDULE="0 3 * * *"
GEMINI_API_KEY=[API_KEY]
```

### Frontend `.env` (Vercel)
```env
VITE_API_BASE_URL=https://seahorse-app-odhgd.ondigitalocean.app/api
```

---

## 8. 📋 Step-by-Step AI Guide for Adding New Features

When requested to build a new feature:
1. **Analyze:** Check whether the feature touches Backend, Frontend, or both.
2. **Schema Changes (if needed):** Update `prisma/schema.prisma` $\rightarrow$ run `npx prisma db push` or apply direct SQL on Supabase.
3. **Backend Implementation:**
   * Add or update routes in `/src/routes/`.
   * Implement controller logic in `/src/controllers/`.
   * Verify BigInt serialization via `serializeChannel`.
   * Verify syntax with `node -c <file>`.
4. **Frontend Implementation:**
   * Call the new endpoint via `api.get()` / `api.post()` from `src/services/api.js`.
   * Update React UI components in `/src/components/` or `/src/pages/`.
   * Verify build with `npm run build`.
5. **Deploy:** Push backend first, followed by frontend to GitHub `origin main`.
