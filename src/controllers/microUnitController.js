import MicroUnit from '../models/MicroUnit.js';
import Channel from '../models/Channel.js';

export async function listMicroUnits(req, res, next) {
  try {
    const microUnits = await MicroUnit.find()
      .populate('channelIds', 'title thumbnailUrl youtubeChannelId currentStats')
      .sort({ name: 1 })
      .lean();

    res.json(microUnits);
  } catch (err) {
    next(err);
  }
}

export async function createMicroUnit(req, res, next) {
  try {
    const { name, channelIds = [], notes = '' } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const ids = Array.isArray(channelIds) ? channelIds : [];
    const validIds = ids.filter((id) => id && typeof id === 'string');

    const microUnit = await MicroUnit.create({
      name: name.trim(),
      channelIds: validIds,
      notes: (notes || '').trim(),
    });

    const populated = await MicroUnit.findById(microUnit._id)
      .populate('channelIds', 'title thumbnailUrl youtubeChannelId currentStats')
      .lean();

    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
}

export async function getMicroUnit(req, res, next) {
  try {
    const microUnit = await MicroUnit.findById(req.params.id)
      .populate('channelIds', 'title thumbnailUrl youtubeChannelId currentStats category')
      .lean();

    if (!microUnit) {
      return res.status(404).json({ message: 'Micro unit not found' });
    }

    res.json(microUnit);
  } catch (err) {
    next(err);
  }
}

export async function updateMicroUnit(req, res, next) {
  try {
    const { name, channelIds, notes } = req.body;

    const update = {};
    if (name !== undefined) update.name = String(name).trim();
    if (Array.isArray(channelIds)) {
      update.channelIds = channelIds.filter((id) => id && typeof id === 'string');
    }
    if (notes !== undefined) update.notes = String(notes).trim();

    const microUnit = await MicroUnit.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    )
      .populate('channelIds', 'title thumbnailUrl youtubeChannelId currentStats')
      .lean();

    if (!microUnit) {
      return res.status(404).json({ message: 'Micro unit not found' });
    }

    res.json(microUnit);
  } catch (err) {
    next(err);
  }
}

export async function deleteMicroUnit(req, res, next) {
  try {
    const microUnit = await MicroUnit.findByIdAndDelete(req.params.id);

    if (!microUnit) {
      return res.status(404).json({ message: 'Micro unit not found' });
    }

    res.json({ message: 'Micro unit deleted', id: req.params.id });
  } catch (err) {
    next(err);
  }
}
