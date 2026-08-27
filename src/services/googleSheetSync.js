import { prisma } from '../config/prisma.js';
import { fetchSingleChannel, resolveChannelByHandle, fetchChannelByHandle } from './youtubeApi.js';
import { extractChannelId, parseYoutubeStatInt } from '../utils/helpers.js';
import { utcStartOfDay } from '../utils/dateUtc.js';
import { parse } from 'csv-parse/sync';

const SPREADSHEET_ID = '1rF7tGOjn5gdEWnn3DEwao51wPvDIf2xLgD_WJk47xA0';

const SHEET_TABS = [
  { name: 'Grade A', category: 'Dedicated - Grade A' },
  { name: 'Grade B', category: 'Dedicated - Grade B' },
  { name: 'Grade C', category: 'Dedicated - Grade C' },
  { name: 'Grade D', category: 'Dedicated - Grade D' },
  { name: 'Grade E', category: 'Dedicated - Grade E' },
  { name: 'Inactive', category: 'Dedicated - Inactive' },
];

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:@[\w.\u0900-\u097F\u0600-\u06FF-]+|channel\/UC[\w-]{22}|c\/[\w.-]+|user\/[\w.-]+)/gi;

export async function previewGoogleSheetSync() {
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
    alreadyAddedCount: 0,
    handleChangedCount: 0,
    notFoundCount: 0,
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
            youtubeChannelId = extracted;
            ytData = await fetchSingleChannel(youtubeChannelId);
          } else if (extracted.handle) {
            ytData = await fetchChannelByHandle(extracted.handle);
            if (ytData) {
              youtubeChannelId = ytData.snippet?.channelId || ytData.id;
            }
          }

          if (!youtubeChannelId || !ytData) {
            statusState = 'CHANNEL_NOT_FOUND';
            summary.notFoundCount++;
          }
        }

        if (youtubeChannelId && ytData) {
          const existingInDB = dbMap.get(youtubeChannelId);
          const currentHandleOrUrl = ytData.snippet?.customUrl || '';
          
          if (existingInDB) {
            // Check if handle changed
            // Ensure we compare strings properly. Sometimes handles have @, sometimes they don't.
            const dbHandle = (existingInDB.customUrl || '').replace(/^@/, '');
            const currHandle = currentHandleOrUrl.replace(/^@/, '');
            
            if (dbHandle !== currHandle && currHandle !== '') {
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

  return {
    items: uniqueItems,
    summary,
  };
}

export async function importApprovedSheetChannels(payload = {}) {
  const { newChannels = [], updatedChannels = [] } = payload;
  let importedCount = 0;
  let updatedCount = 0;
  const errors = [];

  for (const ch of updatedChannels) {
    try {
      if (!ch.dbId) continue;
      await prisma.channel.update({
        where: { id: ch.dbId },
        data: {
          customUrl: ch.currentHandle || '',
          title: ch.name || '',
          thumbnailUrl: ch.thumbnail || ''
        }
      });
      updatedCount++;
    } catch (err) {
      errors.push({ id: ch.id, message: err.message });
    }
  }

  for (const ch of newChannels) {
    try {
      if (!ch.youtubeChannelId || ch.youtubeChannelId === 'UNRESOLVED') continue;
      await prisma.channel.create({
        data: {
          youtubeChannelId: ch.youtubeChannelId,
          title: ch.name || ch.youtubeChannelId,
          customUrl: ch.currentHandle || '',
          thumbnailUrl: ch.thumbnail || '',
          category: ch.category || 'Uncategorized',
          status: 'active',
          classification: 'green'
        }
      });
      importedCount++;
    } catch (err) {
      if (err.code !== 'P2002') {
        errors.push({ id: ch.id, message: err.message });
      }
    }
  }

  return { importedCount, updatedCount, errors };
}
