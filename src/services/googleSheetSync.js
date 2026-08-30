import { prisma } from '../config/prisma.js';
import { fetchSingleChannel, resolveChannelByHandle, fetchChannelByHandle } from './youtubeApi.js';
import { extractChannelId, parseYoutubeStatInt } from '../utils/helpers.js';
import { utcStartOfDay } from '../utils/dateUtc.js';
import { parse } from 'csv-parse/sync';

const SPREADSHEETS = {
  dedicated: {
    id: '1rF7tGOjn5gdEWnn3DEwao51wPvDIf2xLgD_WJk47xA0',
    title: 'Dedicated Master Database',
    tabs: [
      { name: 'Grade A', category: 'Dedicated - Grade A' },
      { name: 'Grade B', category: 'Dedicated - Grade B' },
      { name: 'Grade C', category: 'Dedicated - Grade C' },
      { name: 'Grade D', category: 'Dedicated - Grade D' },
      { name: 'Grade E', category: 'Dedicated - Grade E' },
      { name: 'Inactive', category: 'Dedicated - Inactive' },
    ],
  },
  ihi: {
    id: '1J027IUUkk6wWvbactK6qgRwYUWoEafIxIScQwiDq1BU',
    title: 'IHI Master Database',
    tabs: [
      { name: 'Grade A', category: 'IHI - Grade A' },
      { name: 'Grade B', category: 'IHI - Grade B' },
      { name: 'Grade C', category: 'IHI - Grade C' },
      { name: 'Grade D', category: 'IHI - Grade D' },
      { name: 'Grade E', category: 'IHI - Grade E' },
      { name: 'Inactive', category: 'IHI - Inactive' },
    ],
  },
};

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:@[\w.\u0900-\u097F\u0600-\u06FF-]+|channel\/UC[\w-]{22}|c\/[\w.-]+|user\/[\w.-]+)/gi;

export async function previewGoogleSheetSync(options = {}) {
  const sheetType = (options.sheetType || 'dedicated').toLowerCase();
  const config = SPREADSHEETS[sheetType] || SPREADSHEETS.dedicated;
  const SPREADSHEET_ID = config.id;
  const SHEET_TABS = config.tabs;

  const allDbChannels = await prisma.channel.findMany({
    select: {
      id: true,
      youtubeChannelId: true,
      title: true,
      category: true,
      status: true,
      customUrl: true,
      thumbnailUrl: true
    },
  });

  const dbMapById = new Map();
  const dbMapByHandle = new Map();

  for (const c of allDbChannels) {
    if (c.youtubeChannelId) {
      dbMapById.set(c.youtubeChannelId.trim(), c);
    }
    if (c.customUrl) {
      const cleanHandle = c.customUrl.replace(/^@/, '').trim().toLowerCase();
      if (cleanHandle) {
        dbMapByHandle.set(cleanHandle, c);
      }
    }
  }

  const candidateItems = [];
  const summary = {
    totalSheetChannels: 0,
    newCount: 0,
    alreadyAddedCount: 0,
    handleChangedCount: 0,
    notFoundCount: 0,
    terminatedCount: 0,
    errorCount: 0,
  };

  const rawLinksToProcess = [];

  for (const tab of SHEET_TABS) {
    const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?sheet=${encodeURIComponent(tab.name)}&tqx=out:csv`;
    const res = await fetch(url);
    if (!res.ok) continue;

    const rawText = await res.text();
    const lines = rawText.split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('Full Name') || l.includes('Channel name') || l.includes('Channel link') || l.includes('ID'));
    const csvText = headerIdx !== -1 ? lines.slice(headerIdx).join('\n') : rawText;

    let records = [];
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        trim: true,
      });
    } catch (err) {
      continue;
    }

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const rowValues = Object.values(r).map((v) => String(v || '').trim());
      const nameInSheet = r['Channel name.'] || rowValues[1] || `Row ${i + 1}`;

      const cellLinks = [];
      for (const val of rowValues) {
        const matches = val.match(YOUTUBE_REGEX);
        if (matches) {
          matches.forEach(m => cellLinks.push(m));
        }
      }

      for (const rawLink of cellLinks) {
        rawLinksToProcess.push({ tab, nameInSheet, rawLink });
      }
    }
  }

  // Process in batches of 5 to avoid quota spikes
  const BATCH_SIZE = 5;
  for (let i = 0; i < rawLinksToProcess.length; i += BATCH_SIZE) {
    const batch = rawLinksToProcess.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async ({ tab, nameInSheet, rawLink }) => {
      summary.totalSheetChannels++;
      let youtubeChannelId = null;
      let ytData = null;
      let statusState = ''; 
      
      try {
        const extracted = extractChannelId(rawLink);
        if (!extracted) {
          statusState = 'CHANNEL_NOT_FOUND';
          summary.notFoundCount++;
        } else {
          if (typeof extracted === 'string') {
            youtubeChannelId = extracted.trim();
            ytData = await fetchSingleChannel(youtubeChannelId);
          } else if (extracted.handle) {
            ytData = await fetchChannelByHandle(extracted.handle);
            if (ytData) {
              youtubeChannelId = (ytData.snippet?.channelId || ytData.id || '').trim();
            }
          }

          if (!youtubeChannelId || !ytData) {
            statusState = 'CHANNEL_NOT_FOUND';
            summary.notFoundCount++;
          }
        }

        if (youtubeChannelId && ytData) {
          const currentHandleOrUrl = ytData.snippet?.customUrl || '';
          const cleanLiveHandle = currentHandleOrUrl.replace(/^@/, '').trim().toLowerCase();

          // Primary lookup by Channel ID
          let existingInDB = dbMapById.get(youtubeChannelId);

          // Fallback lookup: try matching by handle if available
          if (!existingInDB && cleanLiveHandle) {
            existingInDB = dbMapByHandle.get(cleanLiveHandle);
          }

          if (existingInDB) {
            // Check if handle or title changed
            const dbHandle = (existingInDB.customUrl || '').replace(/^@/, '').trim().toLowerCase();
            const dbTitle = (existingInDB.title || '').trim();
            const currTitle = (ytData.snippet?.title || '').trim();

            const handleChanged = Boolean(cleanLiveHandle && dbHandle && dbHandle !== cleanLiveHandle);
            const titleChanged = Boolean(currTitle && dbTitle && dbTitle.toLowerCase() !== currTitle.toLowerCase());

            if (handleChanged || titleChanged) {
              statusState = 'HANDLE_CHANGED';
              summary.handleChangedCount++;
            } else {
              statusState = 'ALREADY_ADDED';
              summary.alreadyAddedCount++;
            }

            candidateItems.push({
              id: youtubeChannelId, // Use Channel ID as key to deduplicate
              dbId: existingInDB.id,
              tabName: tab.name,
              category: existingInDB.category,
              name: ytData.snippet.title || existingInDB.title,
              thumbnail: ytData.snippet.thumbnails?.default?.url || existingInDB.thumbnailUrl,
              rawLink,
              currentHandle: currentHandleOrUrl,
              previousHandle: existingInDB.customUrl,
              previousTitle: existingInDB.title,
              youtubeChannelId,
              statusState,
            });
          } else {
            statusState = 'NEW_CHANNEL';
            summary.newCount++;
            candidateItems.push({
              id: youtubeChannelId,
              tabName: tab.name,
              category: tab.category,
              name: ytData.snippet.title,
              thumbnail: ytData.snippet.thumbnails?.default?.url,
              rawLink,
              currentHandle: currentHandleOrUrl,
              youtubeChannelId,
              statusState,
            });
          }
        } else {
          // Check if this channel was previously in our database
          let previouslyInDB = null;
          if (extracted) {
            if (typeof extracted === 'string') {
              previouslyInDB = dbMapById.get(extracted.trim());
            } else if (extracted.handle) {
              const cleanHandle = extracted.handle.replace(/^@/, '').trim().toLowerCase();
              previouslyInDB = dbMapByHandle.get(cleanHandle);
            }
          }

          if (previouslyInDB) {
            statusState = 'CHANNEL_TERMINATED';
            summary.terminatedCount = (summary.terminatedCount || 0) + 1;
            candidateItems.push({
              id: previouslyInDB.youtubeChannelId || `terminated-${Math.random()}`,
              dbId: previouslyInDB.id,
              tabName: tab.name,
              category: previouslyInDB.category,
              name: previouslyInDB.title || nameInSheet,
              rawLink,
              currentHandle: previouslyInDB.customUrl || (extracted?.handle ? `@${extracted.handle}` : ''),
              youtubeChannelId: previouslyInDB.youtubeChannelId || 'UNRESOLVED',
              statusState,
            });
          } else {
            statusState = 'CHANNEL_NOT_FOUND';
            candidateItems.push({
              id: `notfound-${Math.random()}`,
              tabName: tab.name,
              category: tab.category,
              name: nameInSheet,
              rawLink,
              youtubeChannelId: 'UNRESOLVED',
              statusState,
            });
          }
        }
      } catch (err) {
        statusState = 'ERROR';
        summary.errorCount++;
        candidateItems.push({
          id: `error-${Math.random()}`,
          tabName: tab.name,
          category: tab.category,
          name: nameInSheet,
          rawLink,
          youtubeChannelId: 'UNRESOLVED',
          statusState,
          error: err.message
        });
      }
    }));
  }

  // Deduplicate candidateItems based on youtubeChannelId to prevent showing the same channel twice if it appears in multiple sheets
  const uniqueItems = [];
  const seenIds = new Set();
  
  for (const item of candidateItems) {
    if (item.youtubeChannelId !== 'UNRESOLVED') {
      if (!seenIds.has(item.youtubeChannelId)) {
        seenIds.add(item.youtubeChannelId);
        uniqueItems.push(item);
      }
    } else {
      uniqueItems.push(item);
    }
  }

  // Compute exact summary counts on the deduplicated channel list
  const finalSummary = {
    totalSheetChannels: uniqueItems.length,
    rawLinksCount: candidateItems.length,
    newCount: uniqueItems.filter(i => i.statusState === 'NEW_CHANNEL').length,
    alreadyAddedCount: uniqueItems.filter(i => i.statusState === 'ALREADY_ADDED').length,
    handleChangedCount: uniqueItems.filter(i => i.statusState === 'HANDLE_CHANGED').length,
    terminatedCount: uniqueItems.filter(i => i.statusState === 'CHANNEL_TERMINATED').length,
    notFoundCount: uniqueItems.filter(i => i.statusState === 'CHANNEL_NOT_FOUND' || i.statusState === 'ERROR').length,
    errorCount: uniqueItems.filter(i => i.statusState === 'ERROR').length,
  };

  return {
    items: uniqueItems,
    summary: finalSummary,
  };
}

export async function importApprovedSheetChannels(payload = {}) {
  const { newChannels = [], updatedChannels = [] } = payload;
  let importedCount = 0;
  let updatedCount = 0;
  const errors = [];
  const today = utcStartOfDay();

  for (const ch of updatedChannels) {
    try {
      if (!ch.dbId) continue;
      const updateData = {
        customUrl: ch.currentHandle || '',
        title: ch.name || '',
        thumbnailUrl: ch.thumbnail || ''
      };
      if (ch.youtubeChannelId && ch.youtubeChannelId !== 'UNRESOLVED') {
        updateData.youtubeChannelId = ch.youtubeChannelId.trim();
      }
      await prisma.channel.update({
        where: { id: ch.dbId },
        data: updateData
      });
      updatedCount++;
    } catch (err) {
      errors.push({ id: ch.id, message: err.message });
    }
  }

  for (const ch of newChannels) {
    try {
      if (!ch.youtubeChannelId || ch.youtubeChannelId === 'UNRESOLVED') continue;
      const channelIdClean = ch.youtubeChannelId.trim();
      const channelCategory = ch.category || 'Uncategorized';

      // Ensure category exists in Category table
      try {
        await prisma.category.upsert({
          where: { name: channelCategory },
          update: {},
          create: { name: channelCategory },
        });
      } catch {
        // ignore if concurrent
      }

      const created = await prisma.channel.create({
        data: {
          youtubeChannelId: channelIdClean,
          title: ch.name || channelIdClean,
          customUrl: ch.currentHandle || '',
          thumbnailUrl: ch.thumbnail || '',
          category: channelCategory,
          status: 'active',
          lastSyncedAt: new Date(),
        }
      });

      // Create initial snapshot for today
      try {
        await prisma.channelSnapshot.create({
          data: {
            channelId: created.id,
            date: today,
            subscribers: 0,
            views: 0n,
            videoCount: 0,
          },
        });
      } catch {
        // snapshot may already exist
      }

      importedCount++;
    } catch (err) {
      if (err.code === 'P2002') {
        // If channel already exists in DB, update category and handle
        try {
          await prisma.channel.update({
            where: { youtubeChannelId: ch.youtubeChannelId.trim() },
            data: {
              category: ch.category || undefined,
              customUrl: ch.currentHandle || undefined,
              title: ch.name || undefined,
              thumbnailUrl: ch.thumbnail || undefined,
            },
          });
          importedCount++;
        } catch (updateErr) {
          errors.push({ id: ch.id, message: updateErr.message });
        }
      } else {
        errors.push({ id: ch.id, message: err.message });
      }
    }
  }

  return { importedCount, updatedCount, errors };
}

export async function findFirstMissingGoogleSheetChannel() { return { found: false }; }
export async function addFirstMissingGoogleSheetChannel() { return {}; }
export async function syncAllGoogleSheetChannels() { return {}; }
