import { prisma } from '../config/prisma.js';

/** Ensure the built-in 'Uncategorized' entry always exists */
async function seedUncategorized() {
  await prisma.category.upsert({
    where: { name: 'Uncategorized' },
    update: {},
    create: { name: 'Uncategorized' },
  });
}

/** GET /api/categories — return all categories with channel counts */
export async function listCategories(req, res, next) {
  try {
    await seedUncategorized();

    // Channel counts per category (exclude archived to match list/dashboard semantics).
    const counts = await prisma.channel.groupBy({
      by: ['category'],
      where: { deletedAt: null, status: { not: 'archived' } },
      _count: { _all: true },
    });
    const countMap = {};
    for (const c of counts) countMap[c.category] = c._count._all;

    const cats = await prisma.category.findMany({ orderBy: { name: 'asc' } });

    // Any category used by channels but not in the categories table → auto-register it.
    const existingNames = new Set(cats.map((c) => c.name));
    const missing = counts
      .map((c) => c.category)
      .filter((n) => n && !existingNames.has(n));
    if (missing.length) {
      await prisma.category.createMany({
        data: missing.map((n) => ({ name: n })),
        skipDuplicates: true,
      });
      for (const n of missing) existingNames.add(n);
    }

    const allCats = await prisma.category.findMany({ orderBy: { name: 'asc' } });
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

    const existing = await prisma.category.findUnique({ where: { name: trimmed } });
    if (existing) return res.status(409).json({ message: 'Category already exists' });

    const cat = await prisma.category.create({ data: { name: trimmed } });
    res.status(201).json({ name: cat.name, count: 0 });
  } catch (err) {
    if (err.code === 'P2002') {
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

    // Update the Category row (404 if missing).
    const existing = await prisma.category.findUnique({ where: { name: oldName } });
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    await prisma.category.update({ where: { name: oldName }, data: { name: trimmed } });

    // Bulk-rebind every channel that referenced the old name.
    const { count } = await prisma.channel.updateMany({
      where: { category: oldName },
      data: { category: trimmed },
    });

    res.json({ oldName, newName: trimmed, channelsUpdated: count });
  } catch (err) {
    if (err.code === 'P2002') {
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

    const existing = await prisma.category.findUnique({ where: { name } });
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    await prisma.category.delete({ where: { name } });

    const { count } = await prisma.channel.updateMany({
      where: { category: name },
      data: { category: 'Uncategorized' },
    });

    res.json({ deleted: name, channelsReassigned: count });
  } catch (err) {
    next(err);
  }
}
