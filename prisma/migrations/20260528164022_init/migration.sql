-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'manager', 'viewer');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "VideoQueueType" AS ENUM ('viral', 'normal', 'event', 'educational', 'other');

-- CreateEnum
CREATE TYPE "VideoQueuePriority" AS ENUM ('high', 'normal', 'low');

-- CreateEnum
CREATE TYPE "VideoQueueStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "SyncLogSyncType" AS ENUM ('channel', 'video', 'dedicated_ingest', 'ihi_ingest', 'ihi_sadhguru_stats');

-- CreateEnum
CREATE TYPE "SyncLogType" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "SyncLogStatus" AS ENUM ('running', 'success', 'partial', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'viewer',
    "refresh_token" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "youtube_channel_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "thumbnail_url" TEXT NOT NULL DEFAULT '',
    "banner_url" TEXT NOT NULL DEFAULT '',
    "custom_url" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "published_at" TIMESTAMPTZ(6),
    "uploads_playlist_id" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'Uncategorized',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assigned_to_id" TEXT,
    "status" "ChannelStatus" NOT NULL DEFAULT 'active',
    "notes" TEXT NOT NULL DEFAULT '',
    "current_subscribers" INTEGER NOT NULL DEFAULT 0,
    "current_views" BIGINT NOT NULL DEFAULT 0,
    "current_video_count" INTEGER NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMPTZ(6),
    "all_videos_pulled" BOOLEAN NOT NULL DEFAULT false,
    "auto_archived_for_inactivity" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" TEXT NOT NULL,
    "youtube_video_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "thumbnail_url" TEXT NOT NULL DEFAULT '',
    "published_at" TIMESTAMPTZ(6),
    "views" BIGINT NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "duration" TEXT NOT NULL DEFAULT '',
    "last_synced_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "classification" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_snapshots" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "date" TIMESTAMPTZ(6) NOT NULL,
    "subscribers" INTEGER NOT NULL DEFAULT 0,
    "views" BIGINT NOT NULL DEFAULT 0,
    "video_count" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_snapshots" (
    "id" TEXT NOT NULL,
    "video_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "date" TIMESTAMPTZ(6) NOT NULL,
    "views" BIGINT NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "video_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "micro_units" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "micro_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "micro_unit_channels" (
    "micro_unit_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,

    CONSTRAINT "micro_unit_channels_pkey" PRIMARY KEY ("micro_unit_id","channel_id")
);

-- CreateTable
CREATE TABLE "video_queue_items" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "video_type" "VideoQueueType" NOT NULL DEFAULT 'normal',
    "event_name" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "priority" "VideoQueuePriority" NOT NULL DEFAULT 'normal',
    "status" "VideoQueueStatus" NOT NULL DEFAULT 'queued',
    "error_message" TEXT NOT NULL DEFAULT '',
    "added_by" TEXT NOT NULL DEFAULT '',
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "video_queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" TEXT NOT NULL,
    "sync_type" "SyncLogSyncType" NOT NULL DEFAULT 'channel',
    "type" "SyncLogType" NOT NULL,
    "status" "SyncLogStatus" NOT NULL DEFAULT 'running',
    "channels_processed" INTEGER NOT NULL DEFAULT 0,
    "videos_processed" INTEGER NOT NULL DEFAULT 0,
    "quota_used" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_config" (
    "id" TEXT NOT NULL DEFAULT 'sync',
    "channel_sync_schedule" TEXT NOT NULL DEFAULT '0 3 * * *',
    "video_sync_schedule" TEXT NOT NULL DEFAULT '0 4 * * *',
    "dedicated_ingest_schedule" TEXT NOT NULL DEFAULT '0 0 * * *',
    "ihi_ingest_schedule" TEXT NOT NULL DEFAULT '0 */6 * * *',
    "ihi_sadhguru_stats_schedule" TEXT NOT NULL DEFAULT '0 5 * * *',
    "channel_sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "video_sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "dedicated_ingest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "ihi_ingest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "ihi_sadhguru_stats_enabled" BOOLEAN NOT NULL DEFAULT true,
    "inactivity_threshold_days" INTEGER NOT NULL DEFAULT 14,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sync_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rbac_config" (
    "id" TEXT NOT NULL DEFAULT 'rbac',
    "pages" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rbac_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_layout" (
    "id" TEXT NOT NULL DEFAULT 'layout',
    "layouts" JSONB NOT NULL DEFAULT '{}',
    "updated_by" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dashboard_layout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "channels_youtube_channel_id_key" ON "channels"("youtube_channel_id");

-- CreateIndex
CREATE INDEX "channels_category_idx" ON "channels"("category");

-- CreateIndex
CREATE INDEX "channels_status_idx" ON "channels"("status");

-- CreateIndex
CREATE INDEX "channels_deleted_at_idx" ON "channels"("deleted_at");

-- CreateIndex
CREATE INDEX "channels_current_subscribers_idx" ON "channels"("current_subscribers" DESC);

-- CreateIndex
CREATE INDEX "channels_current_views_idx" ON "channels"("current_views" DESC);

-- CreateIndex
CREATE INDEX "channels_status_auto_archived_for_inactivity_idx" ON "channels"("status", "auto_archived_for_inactivity");

-- CreateIndex
CREATE UNIQUE INDEX "videos_youtube_video_id_key" ON "videos"("youtube_video_id");

-- CreateIndex
CREATE INDEX "videos_channel_id_idx" ON "videos"("channel_id");

-- CreateIndex
CREATE INDEX "videos_deleted_at_idx" ON "videos"("deleted_at");

-- CreateIndex
CREATE INDEX "videos_channel_id_published_at_idx" ON "videos"("channel_id", "published_at" DESC);

-- CreateIndex
CREATE INDEX "videos_views_idx" ON "videos"("views" DESC);

-- CreateIndex
CREATE INDEX "videos_channel_id_classification_idx" ON "videos"("channel_id", "classification");

-- CreateIndex
CREATE INDEX "channel_snapshots_date_idx" ON "channel_snapshots"("date");

-- CreateIndex
CREATE INDEX "channel_snapshots_deleted_at_idx" ON "channel_snapshots"("deleted_at");

-- CreateIndex
CREATE INDEX "channel_snapshots_channel_id_date_idx" ON "channel_snapshots"("channel_id", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "channel_snapshots_channel_id_date_key" ON "channel_snapshots"("channel_id", "date");

-- CreateIndex
CREATE INDEX "video_snapshots_channel_id_idx" ON "video_snapshots"("channel_id");

-- CreateIndex
CREATE INDEX "video_snapshots_date_idx" ON "video_snapshots"("date");

-- CreateIndex
CREATE INDEX "video_snapshots_deleted_at_idx" ON "video_snapshots"("deleted_at");

-- CreateIndex
CREATE INDEX "video_snapshots_channel_id_date_idx" ON "video_snapshots"("channel_id", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "video_snapshots_video_id_date_key" ON "video_snapshots"("video_id", "date");

-- CreateIndex
CREATE INDEX "micro_unit_channels_channel_id_idx" ON "micro_unit_channels"("channel_id");

-- CreateIndex
CREATE INDEX "video_queue_items_status_created_at_idx" ON "video_queue_items"("status", "created_at");

-- CreateIndex
CREATE INDEX "video_queue_items_priority_status_created_at_idx" ON "video_queue_items"("priority", "status", "created_at");

-- CreateIndex
CREATE INDEX "sync_logs_sync_type_started_at_idx" ON "sync_logs"("sync_type", "started_at" DESC);

-- CreateIndex
CREATE INDEX "sync_logs_started_at_idx" ON "sync_logs"("started_at" DESC);

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_snapshots" ADD CONSTRAINT "channel_snapshots_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_snapshots" ADD CONSTRAINT "video_snapshots_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_snapshots" ADD CONSTRAINT "video_snapshots_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "micro_unit_channels" ADD CONSTRAINT "micro_unit_channels_micro_unit_id_fkey" FOREIGN KEY ("micro_unit_id") REFERENCES "micro_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "micro_unit_channels" ADD CONSTRAINT "micro_unit_channels_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
