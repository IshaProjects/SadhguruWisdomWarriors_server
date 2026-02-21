import Category from '../models/Category.js';
import Channel from '../models/Channel.js';

/** Ensure the built-in 'Uncategorized' entry always exists */
async function seedUncategorized() {
  await Category.updateOne(
    { name: 'Uncategorized' },
    { $setOnInsert: { name: 'Uncategorized' } },
    { upsert: true }
  );
}

/** GET /api/categories — return all categories with channel counts */
export async function listCategories(req, res, next) {
  try {
    await seedUncategorized();

    // Get channel counts per category
    const counts = await Channel.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    const countMap = {};
    counts.forEach((c) => { countMap[c._id] = c.count; });

    const cats = await Category.find().sort({ name: 1 });

    // Any category used by channels but not in the Category collection → auto-register it
    const existingNames = new Set(cats.map((c) => c.name));
    const missing = counts
      .map((c) => c._id)
      .filter((n) => n && !existingNames.has(n));
    if (missing.length) {
      await Category.insertMany(missing.map((n) => ({ name: n })), { ordered: false }).catch(() => {});
      missing.forEach((n) => existingNames.add(n));
    }

    const allCats = await Category.find().sort({ name: 1 });
    res.json(allCats.map((c) => ({ name: c.name, count: countMap[c.name] || 0 })));
  } catch (err) {
    next(err);
  }
}

/** POST /api/categories — create a new category */
export async function createCategory(req, res, next) {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Category name is required' });
    const trimmed = name.trim();

    const existing = await Category.findOne({ name: trimmed });
    if (existing) return res.status(409).json({ message: 'Category already exists' });

    const cat = await Category.create({ name: trimmed });
    res.status(201).json({ name: cat.name, count: 0 });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Category already exists' });
    }
    next(err);
  }
}

/** PUT /api/categories/:name — rename a category */
export async function renameCategory(req, res, next) {
  try {
    const oldName = decodeURIComponent(req.params.name);
    const { name: newName } = req.body;
    if (!newName?.trim()) return res.status(400).json({ message: 'New category name is required' });
    const trimmed = newName.trim();

    if (oldName === trimmed) return res.status(400).json({ message: 'New name must differ from current name' });

    // Update the Category document
    const cat = await Category.findOneAndUpdate({ name: oldName }, { name: trimmed }, { new: true });
    if (!cat) return res.status(404).json({ message: 'Category not found' });

    // Bulk-update all channels using the old name
    const { modifiedCount } = await Channel.updateMany(
      { category: oldName },
      { $set: { category: trimmed } }
    );

    res.json({ oldName, newName: trimmed, channelsUpdated: modifiedCount });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'A category with that name already exists' });
    }
    next(err);
  }
}

/** DELETE /api/categories/:name — delete a category; channels fall back to 'Uncategorized' */
export async function deleteCategory(req, res, next) {
  try {
    const name = decodeURIComponent(req.params.name);
    if (name === 'Uncategorized') {
      return res.status(400).json({ message: 'Cannot delete the Uncategorized category' });
    }

    const cat = await Category.findOneAndDelete({ name });
    if (!cat) return res.status(404).json({ message: 'Category not found' });

    const { modifiedCount } = await Channel.updateMany(
      { category: name },
      { $set: { category: 'Uncategorized' } }
    );

    res.json({ deleted: name, channelsReassigned: modifiedCount });
  } catch (err) {
    next(err);
  }
}
