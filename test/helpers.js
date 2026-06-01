// Test helpers: createUser, signAccessToken, authFor.
// `authFor(role)` mints a Bearer token whose payload matches what authenticate()
// expects: { id: <user.id> }.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from './setup.js';

let seq = 0;

export async function createUser(overrides = {}) {
  seq += 1;
  const plainPassword = overrides.password ?? 'password123';
  const password = await bcrypt.hash(plainPassword, 12);
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user${seq}@test.local`,
      name: overrides.name ?? `User ${seq}`,
      password,
      role: overrides.role ?? 'viewer',
      ...overrides,
      password, // ensure hashed even if overrides.password was passed
    },
  });
}

export function signAccessToken(user) {
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE,
  });
}

export async function authFor(role = 'admin', overrides = {}) {
  const user = await createUser({ role, ...overrides });
  const token = signAccessToken(user);
  return { user, token, headers: { Authorization: `Bearer ${token}` } };
}
