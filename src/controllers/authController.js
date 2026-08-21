import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma.js';

// SECURITY NOTE — Prisma's default `findUnique`/`findMany` return ALL scalar
// fields, including `password` and `refreshToken`. Every read that flows back
// to the caller MUST use an explicit `select` to project those secrets away.
// The hashed password / refresh token are only fetched in dedicated lookups
// (used by login / refresh) and are never echoed in responses.
//
// The bcrypt pre('save') hook that used to live on the Mongoose model is gone:
// every code path that writes a password to the DB must hash it explicitly
// before calling prisma.user.create / prisma.user.update.

const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  approved: true,
  createdAt: true,
  updatedAt: true,
};

const TEAM_LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  approved: true,
  createdAt: true,
};

const VALID_ROLES = ['admin', 'manager', 'viewer', 'poc'];

/** Bcrypt-hash a plaintext password using the same cost factor the legacy
 *  Mongoose pre('save') hook used (12). */
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

/** Constant-time bcrypt comparison helper — replaces user.comparePassword(). */
export async function comparePassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

function generateTokens(userId) {
  const accessToken = jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '15m',
  });
  const refreshToken = jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d' }
  );
  return { accessToken, refreshToken };
}

export async function register(req, res, next) {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    // First user becomes admin and is automatically approved
    const userCount = await prisma.user.count();
    const isFirstUser = userCount === 0;
    const role = isFirstUser ? 'admin' : 'viewer';
    const approved = isFirstUser ? true : false;

    // Hash explicitly — no pre('save') hook now that we're on Prisma.
    const hashed = await hashPassword(password);

    const created = await prisma.user.create({
      data: { email, password: hashed, name, role, approved },
      select: PUBLIC_USER_SELECT,
    });

    const tokens = generateTokens(created.id);

    // Persist the refresh token. Use a follow-up update rather than a
    // create-with-token so we never echo the value back from the create call.
    await prisma.user.update({
      where: { id: created.id },
      data: { refreshToken: tokens.refreshToken },
      select: { id: true },
    });

    res.status(201).json({
      user: { id: created.id, email: created.email, name: created.name, role: created.role, approved: created.approved },
      ...tokens,
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ message: 'Email already registered' });
    }
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // Need the hashed password & approved flag to verify — fetched only here, never returned.
    const credsRow = await prisma.user.findUnique({
      where: { email },
      select: { id: true, password: true, approved: true },
    });
    if (!credsRow || !(await comparePassword(password, credsRow.password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (credsRow.approved === false) {
      return res.status(403).json({ message: 'Your account is pending admin approval' });
    }

    const tokens = generateTokens(credsRow.id);

    const updated = await prisma.user.update({
      where: { id: credsRow.id },
      data: { refreshToken: tokens.refreshToken },
      select: PUBLIC_USER_SELECT,
    });

    res.json({
      user: { id: updated.id, email: updated.email, name: updated.name, role: updated.role },
      ...tokens,
    });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token required' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // Fetch the stored token for comparison, plus the id we'll sign new ones
    // with. NOTHING else is selected here so we cannot accidentally leak it.
    const stored = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, refreshToken: true },
    });

    if (!stored || stored.refreshToken !== refreshToken) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const tokens = generateTokens(stored.id);
    await prisma.user.update({
      where: { id: stored.id },
      data: { refreshToken: tokens.refreshToken },
      select: { id: true },
    });

    res.json(tokens);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Refresh token expired' });
    }
    next(err);
  }
}

export async function getMe(req, res) {
  // `req.user` is populated by authenticate() which already projects away
  // password/refreshToken — we trust it. (Belt-and-braces: only echo the
  // fields we know to be public.)
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
    },
  });
}

export async function getTeamMembers(req, res, next) {
  try {
    const users = await prisma.user.findMany({
      select: TEAM_LIST_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    const shaped = users.map((u) => ({
      ...u,
      _id: u.id,
      approved: u.approved !== false,
    }));
    res.json(shaped);
  } catch (err) {
    next(err);
  }
}

export async function inviteUser(req, res, next) {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ message: 'Email, name and password are required' });
    }

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const hashed = await hashPassword(password);

    const created = await prisma.user.create({
      data: {
        email,
        name,
        password: hashed,
        role: role || 'viewer',
      },
      select: PUBLIC_USER_SELECT,
    });

    res.status(201).json({
      _id: created.id,
      email: created.email,
      name: created.name,
      role: created.role,
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ message: 'Email already registered' });
    }
    next(err);
  }
}

export async function updateTeamMember(req, res, next) {
  try {
    const { name, email, role, approved } = req.body;
    const update = {};

    if (name !== undefined) update.name = name;
    if (approved !== undefined) update.approved = Boolean(approved);
    if (email !== undefined) {
      // Check if email is already taken by another user
      const existing = await prisma.user.findFirst({
        where: { email, NOT: { id: req.params.id } },
        select: { id: true },
      });
      if (existing) {
        return res.status(409).json({ message: 'Email already in use by another user' });
      }
      update.email = email;
    }
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ message: 'Invalid role' });
      }
      update.role = role;
    }

    // Prevent demoting yourself
    if (req.params.id === String(req.user.id) && role && role !== req.user.role) {
      return res.status(400).json({ message: 'You cannot change your own role' });
    }

    try {
      const user = await prisma.user.update({
        where: { id: req.params.id },
        data: update,
        select: TEAM_LIST_SELECT,
      });
      res.json({ ...user, _id: user.id, approved: user.approved !== false });
    } catch (err) {
      if (err.code === 'P2025') {
        return res.status(404).json({ message: 'User not found' });
      }
      throw err;
    }
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ message: 'Email already in use by another user' });
    }
    next(err);
  }
}

export async function deleteTeamMember(req, res, next) {
  try {
    // Prevent deleting yourself
    if (req.params.id === String(req.user.id)) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    try {
      await prisma.user.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (err.code === 'P2025') {
        return res.status(404).json({ message: 'User not found' });
      }
      throw err;
    }

    res.json({ message: 'Team member deleted' });
  } catch (err) {
    next(err);
  }
}
