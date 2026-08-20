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
  status: true,
  createdAt: true,
  updatedAt: true,
};

const TEAM_LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
};

const VALID_ROLES = ['admin', 'manager', 'viewer', 'poc'];
const VALID_STATUSES = ['pending', 'approved', 'rejected'];

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

    // First user becomes admin and approved; others default to viewer and pending
    const userCount = await prisma.user.count();
    const role = userCount === 0 ? 'admin' : 'viewer';
    const status = userCount === 0 ? 'approved' : 'pending';

    // Hash explicitly — no pre('save') hook now that we're on Prisma.
    const hashed = await hashPassword(password);

    const created = await prisma.user.create({
      data: { email, password: hashed, name, role, status },
      select: PUBLIC_USER_SELECT,
    });

    if (status === 'pending') {
      return res.status(201).json({
        message: 'Account created successfully. Your registration is pending Admin approval.',
        user: { id: created.id, email: created.email, name: created.name, role: created.role, status: created.status },
        pendingApproval: true,
      });
    }

    const tokens = generateTokens(created.id);

    await prisma.user.update({
      where: { id: created.id },
      data: { refreshToken: tokens.refreshToken },
      select: { id: true },
    });

    res.status(201).json({
      user: { id: created.id, email: created.email, name: created.name, role: created.role, status: created.status },
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

    // Need the hashed password & status to verify
    const credsRow = await prisma.user.findUnique({
      where: { email },
      select: { id: true, password: true, status: true },
    });
    if (!credsRow || !(await comparePassword(password, credsRow.password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (credsRow.status === 'pending') {
      return res.status(403).json({ message: 'Your account is pending Admin approval.' });
    }
    if (credsRow.status === 'rejected') {
      return res.status(403).json({ message: 'Your account registration was rejected by Admin.' });
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
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      status: req.user.status,
    },
  });
}

export async function getTeamMembers(req, res, next) {
  try {
    const users = await prisma.user.findMany({
      select: TEAM_LIST_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  } catch (err) {
    next(err);
  }
}

export async function getPocUsers(req, res, next) {
  try {
    const pocs = await prisma.user.findMany({
      where: {
        role: 'poc',
        status: 'approved',
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
      },
      orderBy: { name: 'asc' },
    });
    res.json(pocs);
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
        status: 'approved', // Admin invited users are auto-approved
      },
      select: PUBLIC_USER_SELECT,
    });

    res.status(201).json({
      _id: created.id,
      id: created.id,
      email: created.email,
      name: created.name,
      role: created.role,
      status: created.status,
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
    const { name, email, role, status } = req.body;
    const update = {};

    if (name !== undefined) update.name = name;
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
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      update.status = status;
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
      res.json(user);
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
