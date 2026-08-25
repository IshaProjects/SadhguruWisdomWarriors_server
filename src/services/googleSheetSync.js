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

/** Find the very first channel in the 6 Google Sheet tabs that is NOT present in the DB */
export async function findFirstMissingGoogleSheetChannel() {
  const dbChannels = await prisma.channel.findMany({
    where: { deletedAt: null },
    select: { youtubeChannelId: true },
  });

  const existingSet = new Set(dbChannels.map((c) => c.youtubeChannelId).filter(Boolean));
  const scanDetails = [];

  for (const tab of SHEET_TABS) {
    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?sheet=${encodeURIComponent(tab.name)}&tqx=out:csv`;
    const res = await fetch(url);
    if (!res.ok) {
      scanDetails.push({ tabName: tab.name, fetchStatus: res.status, error: 'HTTP fetch failed' });
      continue;
    }

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

    let linksFound = 0;
    let resolvedCount = 0;
    let missingFoundInTab = [];

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const rawLink = extractRowYoutubeLink(r);
      if (!rawLink) continue;
      linksFound++;

      const youtubeChannelId = await resolveToYoutubeChannelId(rawLink);
      if (!youtubeChannelId) continue;
      resolvedCount++;

      if (!existingSet.has(youtubeChannelId)) {
        const rowValues = Object.values(r).map((v) => String(v || '').trim());
        const nameInSheet = r['Channel name.'] || rowValues[1] || `Row ${i + 1}`;

        missingFoundInTab.push({
          rowNumber: i + 1,
          nameInSheet,
          rawLink,
          youtubeChannelId,
        });
      }
    }

    scanDetails.push({
      tabName: tab.name,
      category: tab.category,
      recordsCount: records.length,
      linksFound,
      resolvedCount,
      missingCount: missingFoundInTab.length,
      firstMissingSample: missingFoundInTab[0] || null,
    });

    if (missingFoundInTab.length > 0) {
      const first = missingFoundInTab[0];
      return {
        found: true,
        dbChannelCount: existingSet.size,
        tabName: tab.name,
        category: tab.category,
        youtubeChannelId: first.youtubeChannelId,
        nameInSheet: first.nameInSheet,
        rawLink: first.rawLink,
        rowNumber: first.rowNumber,
        scanDetails,
      };
    }
  }

  return {
    found: false,
    dbChannelCount: existingSet.size,
    message: 'All YouTube channels across the 6 Google Sheet tabs are already present in the web app database.',
    scanDetails,
  };
}

/** Add ONLY the first missing channel found in the Google Sheet tabs into the database */
export async function addFirstMissingGoogleSheetChannel() {
  const target = await findFirstMissingGoogleSheetChannel();

  if (!target.found) {
    return { added: false, message: target.message };
  }

  const { youtubeChannelId, category, tabName, nameInSheet } = target;

  const existing = await prisma.channel.findFirst({
    where: { youtubeChannelId, deletedAt: null },
  });
  if (existing) {
    return { added: false, message: 'Channel already exists', channel: existing };
  }

  const ytData = await fetchSingleChannel(youtubeChannelId);
  if (!ytData) {
    throw new Error(`Failed to fetch channel details from YouTube API for ${youtubeChannelId}`);
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
      category: category,
      tags: ['Google Sheet Sync'],
      notes: `Imported from Google Sheet tab "${tabName}"`,
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

  return {
    added: true,
    tabName,
    category,
    channel: {
      id: channel.id,
      youtubeChannelId: channel.youtubeChannelId,
      title: channel.title,
      category: channel.category,
      customUrl: channel.customUrl,
      currentSubscribers: channel.currentSubscribers,
    },
  };
}

/** Sync all missing channels from the 6 Google Sheet tabs into the database */
export async function syncAllGoogleSheetChannels() {
  const dbChannels = await prisma.channel.findMany({
    where: { deletedAt: null },
    select: { youtubeChannelId: true },
  });

  const existingSet = new Set(dbChannels.map((c) => c.youtubeChannelId).filter(Boolean));
  const results = { added: 0, skipped: 0, addedChannels: [], errors: [] };

  for (const tab of SHEET_TABS) {
    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?sheet=${encodeURIComponent(tab.name)}&tqx=out:csv`;
    const res = await fetch(url);
    if (!res.ok) continue;

    const csvText = await res.text();
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

      try {
        const youtubeChannelId = await resolveToYoutubeChannelId(rawLink);
        if (!youtubeChannelId) continue;

        if (existingSet.has(youtubeChannelId)) {
          results.skipped++;
          continue;
        }

        const ytData = await fetchSingleChannel(youtubeChannelId);
        if (!ytData) {
          results.errors.push({ rawLink, error: 'Not found on YouTube' });
          continue;
        }

        const rowValues = Object.values(r).map((v) => String(v || '').trim());
        const nameInSheet = r['Channel name.'] || rowValues[1] || `Row ${i + 1}`;

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
            category: tab.category,
            tags: ['Google Sheet Sync'],
            notes: `Imported from Google Sheet tab "${tab.name}"`,
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

        existingSet.add(youtubeChannelId);
        results.added++;
        results.addedChannels.push({
          id: channel.id,
          youtubeChannelId,
          title: channel.title,
          category: tab.category,
        });
      } catch (err) {
        results.errors.push({ rawLink, error: err.message });
      }
    }
  }

  return results;
}
