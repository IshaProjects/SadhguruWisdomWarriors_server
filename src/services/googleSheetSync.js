import { prisma } from '../config/prisma.js';
import { fetchSingleChannel, resolveChannelByHandle } from './youtubeApi.js';
import { extractChannelId, parseYoutubeStatInt } from '../utils/helpers.js';
import { utcStartOfDay } from '../utils/dateUtc.js';
import { parse } from 'csv-parse/sync';

const SPREADSHEET_ID = '1rF7tGOjn5gdEWnn3DEwao51wPvDIf2xLgD_WJk47xA0';

const SHEET_TABS = [
  { name: 'Grade A', category: 'Dedicated Grade A' },
  { name: 'Grade B', category: 'Dedicated Grade B' },
  { name: 'Grade C', category: 'Dedicated Grade C' },
  { name: 'Grade D', category: 'Dedicated Grade D' },
  { name: 'Grade E', category: 'Dedicated Grade E' },
  { name: 'Inactive', category: 'Dedicated Inactive' },
];

/** Extract YouTube link or handle from any row object in Google Sheets CSV */
function extractRowYoutubeLink(row) {
  const rowValues = Object.values(row).map((v) => String(v || '').trim());
  let link = rowValues.find((v) => v.includes('youtube.com') || v.includes('youtu.be'));
  if (!link) {
    link = rowValues.find((v) => /^@[\w.-]+$/.test(v) || /^UC[\w-]{22}$/.test(v));
  }
  return link || null;
}

/** Resolve canonical YouTube Channel ID (UC...) from a link or handle */
async function resolveToYoutubeChannelId(rawLink) {
  if (!rawLink) return null;
  const extracted = extractChannelId(rawLink);

  if (typeof extracted === 'string') {
    if (/^UC[\w-]{22}$/.test(extracted)) {
      return extracted;
    }
    return resolveChannelByHandle(extracted);
  } else if (extracted && extracted.handle) {
    return resolveChannelByHandle(extracted.handle);
  }
  return null;
}

/** Preview all candidate channels across the 6 Google Sheet tabs with DB status (including soft-deleted) */
export async function previewGoogleSheetSync() {
  const allDbChannels = await prisma.channel.findMany({
    select: {
      id: true,
      youtubeChannelId: true,
      title: true,
      category: true,
      status: true,
      deletedAt: true,
    },
  });

  const dbMap = new Map();
  for (const c of allDbChannels) {
    if (c.youtubeChannelId) {
      dbMap.set(c.youtubeChannelId, c);
    }
  }

  const candidateItems = [];
  const summary = {
    totalSheetChannels: 0,
    newCount: 0,
    deletedCount: 0,
    activeCount: 0,
  };

  for (const tab of SHEET_TABS) {
    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?sheet=${encodeURIComponent(tab.name)}&tqx=out:csv`;
    const res = await fetch(url);
    if (!res.ok) continue;

    const rawText = await res.text();
    const lines = rawText.split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('Full Name') || l.includes('Channel name') || l.includes('Channel link') || l.includes('ID'));
    const csvText = headerIdx !== -1 ? lines.slice(headerIdx).join('\n') : rawText;

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    });

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const rawLink = extractRowYoutubeLink(r);
      if (!rawLink) continue;

      summary.totalSheetChannels++;
      const youtubeChannelId = await resolveToYoutubeChannelId(rawLink);

      const rowValues = Object.values(r).map((v) => String(v || '').trim());
      const nameInSheet = r['Channel name.'] || rowValues[1] || `Row ${i + 1}`;

      let cleanUrl = rawLink;
      if (/^UC[\w-]{22}$/.test(rawLink)) {
        cleanUrl = `https://www.youtube.com/channel/${rawLink}`;
      } else {
        const handleMatch = rawLink.match(/@([\w.-]+)/);
        if (handleMatch) {
          cleanUrl = `https://www.youtube.com/@${handleMatch[1]}`;
        }
      }

      const existingInDB = youtubeChannelId ? dbMap.get(youtubeChannelId) : null;
      let statusState = 'new'; // 'new' | 'previously_deleted' | 'active'
      let statusLabel = '🆕 New Channel';

      if (existingInDB) {
        if (existingInDB.deletedAt || existingInDB.status === 'archived' || existingInDB.status === 'deleted') {
          statusState = 'previously_deleted';
          statusLabel = '⚠️ Previously Deleted';
          summary.deletedCount++;
        } else {
          statusState = 'active';
          statusLabel = '✅ Already Active';
          summary.activeCount++;
        }
      } else {
        summary.newCount++;
      }

      candidateItems.push({
        id: `${tab.name}-${i + 1}`,
        tabName: tab.name,
        category: tab.category,
        rowNumber: i + 1,
        nameInSheet,
        rawLink,
        cleanUrl,
        youtubeChannelId: youtubeChannelId || 'UNRESOLVED',
        statusState,
        statusLabel,
        selectedByDefault: statusState === 'new',
      });
    }
  }

  return {
    items: candidateItems,
    summary,
  };
}

/** Import only the channels approved by the user in the pre-import review modal */
export async function importApprovedSheetChannels(approvedItems = []) {
  if (!Array.isArray(approvedItems) || approvedItems.length === 0) {
    return { addedCount: 0, restoredCount: 0, errors: [], channels: [] };
  }

  let addedCount = 0;
  let restoredCount = 0;
  const errors = [];
  const processedChannels = [];

  for (const item of approvedItems) {
    const { youtubeChannelId, category, nameInSheet, tabName } = item;

    if (!youtubeChannelId || youtubeChannelId === 'UNRESOLVED') {
      errors.push({ nameInSheet, error: 'Invalid or unresolved YouTube Channel ID' });
      continue;
    }

    try {
      const existing = await prisma.channel.findFirst({
        where: { youtubeChannelId },
      });

      if (existing) {
        if (existing.deletedAt || existing.status === 'archived') {
          const restored = await prisma.channel.update({
            where: { id: existing.id },
            data: {
              deletedAt: null,
              status: 'active',
              category: category || existing.category,
              notes: `Restored via Google Sheet sync from tab "${tabName || ''}"`,
              updatedAt: new Date(),
            },
          });
          restoredCount++;
          processedChannels.push(restored);
        }
        continue;
      }

      const ytData = await fetchSingleChannel(youtubeChannelId);
      if (!ytData) {
        errors.push({ youtubeChannelId, nameInSheet, error: 'Channel details not found on YouTube API' });
        continue;
      }

      const channel = await prisma.channel.create({
        data: {
          youtubeChannelId,
          title: ytData.snippet.title || nameInSheet || '',
          description: ytData.snippet.description || '',
          thumbnailUrl:
            ytData.snippet.thumbnails?.high?.url ||
            ytData.snippet.thumbnails?.default?.url ||
            '',
          bannerUrl: ytData.brandingSettings?.image?.bannerExternalUrl || '',
          customUrl: ytData.snippet.customUrl || '',
          country: ytData.snippet.country || '',
          publishedAt: ytData.snippet.publishedAt ? new Date(ytData.snippet.publishedAt) : null,
          uploadsPlaylistId: ytData.contentDetails?.relatedPlaylists?.uploads || '',
          category: category || 'Uncategorized',
          tags: ['Google Sheet Sync'],
          notes: `Imported from Google Sheet tab "${tabName || ''}"`,
          currentSubscribers: parseYoutubeStatInt(ytData.statistics?.subscriberCount),
          currentViews: BigInt(parseYoutubeStatInt(ytData.statistics?.viewCount)),
          currentVideoCount: parseYoutubeStatInt(ytData.statistics?.videoCount),
          lastSyncedAt: new Date(),
        },
      });

      const today = utcStartOfDay();
      await prisma.channelSnapshot.create({
        data: {
          channelId: channel.id,
          date: today,
          subscribers: channel.currentSubscribers,
          views: channel.currentViews,
          videoCount: channel.currentVideoCount,
        },
      });

      addedCount++;
      processedChannels.push(channel);
    } catch (err) {
      errors.push({ youtubeChannelId, nameInSheet, error: err.message });
    }
  }

  return {
    addedCount,
    restoredCount,
    totalProcessed: addedCount + restoredCount,
    errors,
    channels: processedChannels,
  };
}

/** Find the very first channel in the 6 Google Sheet tabs that is NOT present in the DB */
export async function findFirstMissingGoogleSheetChannel() {
  const preview = await previewGoogleSheetSync();
  const firstMissing = preview.items.find((item) => item.statusState === 'new');

  if (firstMissing) {
    return {
      found: true,
      ...firstMissing,
    };
  }

  return {
    found: false,
    message: 'All YouTube channels across the 6 Google Sheet tabs are already present in the web app database.',
  };
}

/** Add ONLY the first missing channel found in the Google Sheet tabs into the database */
export async function addFirstMissingGoogleSheetChannel() {
  const target = await findFirstMissingGoogleSheetChannel();

  if (!target.found) {
    return { added: false, message: target.message };
  }

  return importApprovedSheetChannels([target]);
}

/** Sync all missing channels from the 6 Google Sheet tabs into the database */
export async function syncAllGoogleSheetChannels() {
  const preview = await previewGoogleSheetSync();
  const newItems = preview.items.filter((item) => item.statusState === 'new');
  return importApprovedSheetChannels(newItems);
}
