import { prisma } from '../config/prisma.js';

// The legacy Mongoose route returned `channelIds` populated with the related
// channel documents (when `populate('channelIds', 'title thumbnailUrl …')` was
// applied). On Prisma we read through the `MicroUnitChannel` junction and then
// reshape the rows so the API response keeps the SAME `channelIds: [{...}]`
// shape the client already consumes. The fields we project mirror the legacy
// `.populate(..., 'fields')` projections — except that `currentStats` was
// flattened in the new schema into `currentSubscribers / currentViews /
// currentVideoCount`, so we reassemble it under that key for parity.

// Channel field selections used per route — kept in sync with the original
// populate(...) projections in the Mongoose controller.
const LIST_CHANNEL_SELECT = {
  id: true,
  title: true,
  thumbnailUrl: true,
  youtubeChannelId: true,
  currentSubscribers: true,
  currentViews: true,
  currentVideoCount: true,
};

const DETAIL_CHANNEL_SELECT = {
  ...LIST_CHANNEL_SELECT,
  category: true,
};

const POC_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
};

function buildChannelProjection(channel) {
  if (!channel) return null;
  const {
    currentSubscribers,
    currentViews,
    currentVideoCount,
    ...rest
  } = channel;
  return {
    ...rest,
    _id: channel.id,
    currentStats: {
      subscribers: currentSubscribers,
      views: typeof currentViews === 'bigint' ? Number(currentViews) : currentViews,
      videoCount: currentVideoCount,
    },
  };
}

function shapeMicroUnit(mu) {
  if (!mu) return mu;
  const channelIds = (mu.microUnitChannels || []).map((mc) =>
    buildChannelProjection(mc.channel),
  );
  const { microUnitChannels, ...rest } = mu;
  return { ...rest, _id: mu.id, channelIds };
}

export async function listMicroUnits(req, res, next) {
  try {
    const microUnits = await prisma.microUnit.findMany({
      orderBy: { name: 'asc' },
      include: {
        poc: { select: POC_SELECT },
        microUnitChannels: { include: { channel: { select: LIST_CHANNEL_SELECT } } },
      },
    });

    res.json(microUnits.map(shapeMicroUnit));
  } catch (err) {
    next(err);
  }
}

export async function createMicroUnit(req, res, next) {
  try {
    const { name, channelIds = [], notes = '', pocId = null } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const ids = Array.isArray(channelIds) ? channelIds : [];
    const validIds = ids.filter((id) => id && typeof id === 'string');

    if (validIds.length > 5) {
      return res.status(400).json({ message: 'A micro unit can have at most 5 channels' });
    }

    const created = await prisma.microUnit.create({
      data: {
        name: name.trim(),
        notes: (notes || '').trim(),
        pocId: pocId || null,
        microUnitChannels: {
          create: validIds.map((channelId) => ({ channelId })),
        },
      },
      include: {
        poc: { select: POC_SELECT },
        microUnitChannels: { include: { channel: { select: LIST_CHANNEL_SELECT } } },
      },
    });

    res.status(201).json(shapeMicroUnit(created));
  } catch (err) {
    next(err);
  }
}

export async function getMicroUnit(req, res, next) {
  try {
    const microUnit = await prisma.microUnit.findUnique({
      where: { id: req.params.id },
      include: {
        poc: { select: POC_SELECT },
        microUnitChannels: { include: { channel: { select: DETAIL_CHANNEL_SELECT } } },
      },
    });

    if (!microUnit) {
      return res.status(404).json({ message: 'Micro unit not found' });
    }

    res.json(shapeMicroUnit(microUnit));
  } catch (err) {
    next(err);
  }
}

export async function updateMicroUnit(req, res, next) {
  try {
    const { name, channelIds, notes, pocId } = req.body;

    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (notes !== undefined) update.notes = String(notes).trim();
    if (pocId !== undefined) update.pocId = pocId || null;

    const replaceChannels = Array.isArray(channelIds);
    const nextChannelIds = replaceChannels
      ? channelIds.filter((id) => id && typeof id === 'string')
      : null;

    if (nextChannelIds && nextChannelIds.length > 5) {
      return res.status(400).json({ message: 'A micro unit can have at most 5 channels' });
    }

    const existing = await prisma.microUnit.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!existing) {
      return res.status(404).json({ message: 'Micro unit not found' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (Object.keys(update).length) {
        await tx.microUnit.update({
          where: { id: req.params.id },
          data: update,
        });
      }
      if (replaceChannels) {
        await tx.microUnitChannel.deleteMany({
          where: { microUnitId: req.params.id },
        });
        if (nextChannelIds.length) {
          await tx.microUnitChannel.createMany({
            data: nextChannelIds.map((channelId) => ({
              microUnitId: req.params.id,
              channelId,
            })),
            skipDuplicates: true,
          });
        }
      }
      return tx.microUnit.findUnique({
        where: { id: req.params.id },
        include: {
          poc: { select: POC_SELECT },
          microUnitChannels: { include: { channel: { select: LIST_CHANNEL_SELECT } } },
        },
      });
    });

    res.json(shapeMicroUnit(updated));
  } catch (err) {
    next(err);
  }
}

export async function deleteMicroUnit(req, res, next) {
  try {
    try {
      await prisma.microUnit.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (err.code === 'P2025') {
        return res.status(404).json({ message: 'Micro unit not found' });
      }
      throw err;
    }
    res.json({ message: 'Micro unit deleted', id: req.params.id });
  } catch (err) {
    next(err);
  }
}
