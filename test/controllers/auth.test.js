import request from 'supertest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import app from '../../src/app.js';
import { prisma } from '../setup.js';
import { authFor, createUser } from '../helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/auth/register', () => {
  it('201 — creates the first user as admin and returns tokens', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'first@test.local', password: 'password123', name: 'First User' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('first@test.local');
    expect(res.body.user.name).toBe('First User');
  });

  it('201 — second user becomes viewer', async () => {
    // seed one user so the count > 0
    await createUser({ role: 'admin' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'second@test.local', password: 'password123', name: 'Second User' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('viewer');
  });

  it('201 — password is bcrypt-hashed (never stored plain) and absent from response', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'hashcheck@test.local', password: 'plaintext123', name: 'Hash Check' });

    expect(res.status).toBe(201);
    // Response NEVER includes the password / refresh token fields.
    expect(res.body.user.password).toBeUndefined();
    expect(res.body.user.refreshToken).toBeUndefined();

    // DB stores a bcrypt hash, not the plaintext.
    const dbUser = await prisma.user.findUnique({
      where: { email: 'hashcheck@test.local' },
      select: { password: true, refreshToken: true },
    });
    expect(dbUser.password).not.toBe('plaintext123');
    expect(dbUser.password.startsWith('$2')).toBe(true);
    // Bcrypt verifies the original plaintext against the hash.
    expect(await bcrypt.compare('plaintext123', dbUser.password)).toBe(true);
    expect(dbUser.refreshToken).toBeTruthy();
  });

  it('400 — missing email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ password: 'password123', name: 'No Email' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('All fields are required');
  });

  it('400 — missing password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@test.local', name: 'No Password' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('All fields are required');
  });

  it('400 — missing name', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@test.local', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('All fields are required');
  });

  it('409 — duplicate email', async () => {
    await createUser({ email: 'dup@test.local' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@test.local', password: 'password123', name: 'Dup Again' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Email already registered');
  });

  it('500 — DB error in register triggers next(err)', async () => {
    vi.spyOn(prisma.user, 'count').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dberr@test.local', password: 'password123', name: 'DB Error' });

    expect(res.status).toBe(500);
  });

  it('201 — generateTokens uses default expiresIn when JWT_EXPIRE/JWT_REFRESH_EXPIRE are unset', async () => {
    const origExpire = process.env.JWT_EXPIRE;
    const origRefreshExpire = process.env.JWT_REFRESH_EXPIRE;
    delete process.env.JWT_EXPIRE;
    delete process.env.JWT_REFRESH_EXPIRE;

    try {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'nojwtenv@test.local', password: 'password123', name: 'NoJwtEnv' });

      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
    } finally {
      process.env.JWT_EXPIRE = origExpire;
      process.env.JWT_REFRESH_EXPIRE = origRefreshExpire;
    }
  });
});

describe('POST /api/auth/login', () => {
  it('200 — valid credentials return tokens and user info', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'login@test.local', password: 'password123', name: 'Login User' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.local', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('login@test.local');
    // Response NEVER includes password / refreshToken on the embedded user.
    expect(res.body.user.password).toBeUndefined();
    expect(res.body.user.refreshToken).toBeUndefined();
  });

  it('400 — missing email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Email and password are required');
  });

  it('400 — missing password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@test.local' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Email and password are required');
  });

  it('401 — user not found', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: 'password123' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('401 — wrong password', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'wp@test.local', password: 'correctpass', name: 'WP' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'wp@test.local', password: 'wrongpass' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('500 — DB error in login triggers next(err)', async () => {
    vi.spyOn(prisma.user, 'findUnique').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'dberr@test.local', password: 'password123' });

    expect(res.status).toBe(500);
  });
});

describe('POST /api/auth/refresh', () => {
  it('200 — valid refresh token returns new tokens', async () => {
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ref@test.local', password: 'password123', name: 'Ref' });

    const { refreshToken } = registerRes.body;

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it('400 — missing refreshToken', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Refresh token required');
  });

  it('500 — invalid (malformed) refresh token falls through to error handler', async () => {
    // JsonWebTokenError (malformed) is NOT a TokenExpiredError, so it hits next(err) -> 500
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'not.a.valid.token' });

    expect(res.status).toBe(500);
  });

  it('401 — valid JWT but user not found in DB', async () => {
    // Create a token for a non-existent user id
    const fakeId = 'cuid-that-does-not-exist';
    const fakeToken = jwt.sign({ id: fakeId }, process.env.JWT_REFRESH_SECRET, {
      expiresIn: '7d',
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: fakeToken });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('401 — valid JWT but refreshToken does not match stored one', async () => {
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({ email: 'mismatch@test.local', password: 'password123', name: 'Mismatch' });

    const userRow = await prisma.user.findUnique({
      where: { email: 'mismatch@test.local' },
      select: { id: true },
    });
    // Build a valid JWT for this user.
    const differentToken = jwt.sign(
      { id: userRow.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '7d' },
    );
    // Force the stored token to something else so the equality check fails.
    await prisma.user.update({
      where: { id: userRow.id },
      data: { refreshToken: 'completely-different-stored-token' },
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: differentToken });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('401 — expired refresh token', async () => {
    const fakeId = 'cuid-irrelevant';
    const expiredToken = jwt.sign({ id: fakeId }, process.env.JWT_REFRESH_SECRET, {
      expiresIn: '0s',
    });

    // Brief wait so token is definitely expired
    await new Promise((r) => setTimeout(r, 100));

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: expiredToken });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Refresh token expired');
  });
});

describe('GET /api/auth/me', () => {
  it('200 — returns current user info (without password/refreshToken)', async () => {
    const { headers, user } = await authFor('viewer');

    const res = await request(app).get('/api/auth/me').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.user.role).toBe('viewer');
    expect(res.body.user.password).toBeUndefined();
    expect(res.body.user.refreshToken).toBeUndefined();
  });

  it('401 — no token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/team', () => {
  it('200 — admin can list team and rows never include password/refreshToken', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app).get('/api/auth/team').set(headers);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row.password).toBeUndefined();
      expect(row.refreshToken).toBeUndefined();
    }
  });

  it('200 — manager can list team', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app).get('/api/auth/team').set(headers);
    expect(res.status).toBe(200);
  });

  it('403 — viewer cannot list team', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/auth/team').set(headers);
    expect(res.status).toBe(403);
  });

  it('401 — unauthenticated', async () => {
    const res = await request(app).get('/api/auth/team');
    expect(res.status).toBe(401);
  });

  it('500 — DB error in getTeamMembers triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.user, 'findMany').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app).get('/api/auth/team').set(headers);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/auth/invite', () => {
  it('201 — admin can invite a user (default viewer role, password bcrypted)', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ email: 'invited@test.local', name: 'Invited', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('invited@test.local');
    expect(res.body.role).toBe('viewer');
    // Response never includes the password/refreshToken.
    expect(res.body.password).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();

    // Stored password is a bcrypt hash, not the plaintext.
    const dbUser = await prisma.user.findUnique({
      where: { email: 'invited@test.local' },
      select: { password: true },
    });
    expect(dbUser.password).not.toBe('password123');
    expect(await bcrypt.compare('password123', dbUser.password)).toBe(true);
  });

  it('201 — admin can invite with specific role', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ email: 'mgr@test.local', name: 'Manager', password: 'password123', role: 'manager' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('manager');
  });

  it('400 — missing email', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ name: 'No Email', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Email, name and password are required');
  });

  it('400 — missing name', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ email: 'x@test.local', password: 'password123' });

    expect(res.status).toBe(400);
  });

  it('400 — missing password', async () => {
    const { headers } = await authFor('admin');
    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ email: 'x@test.local', name: 'X' });

    expect(res.status).toBe(400);
  });

  it('409 — duplicate email', async () => {
    const { headers } = await authFor('admin');
    await createUser({ email: 'existing@test.local' });

    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ email: 'existing@test.local', name: 'Dup', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Email already registered');
  });

  it('403 — manager cannot invite', async () => {
    const { headers } = await authFor('manager');
    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ email: 'x@test.local', name: 'X', password: 'password123' });

    expect(res.status).toBe(403);
  });

  it('403 — viewer cannot invite', async () => {
    const { headers } = await authFor('viewer');
    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ email: 'x@test.local', name: 'X', password: 'password123' });

    expect(res.status).toBe(403);
  });

  it('500 — DB error in inviteUser triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    vi.spyOn(prisma.user, 'create').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .post('/api/auth/invite')
      .set(headers)
      .send({ email: 'new@test.local', name: 'New', password: 'password123' });

    expect(res.status).toBe(500);
  });
});

describe('PUT /api/auth/team/:id', () => {
  it('200 — admin can update another user name', async () => {
    const { headers } = await authFor('admin');
    const target = await createUser({ name: 'Old Name', email: 'target@test.local' });

    const res = await request(app)
      .put(`/api/auth/team/${target.id}`)
      .set(headers)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.password).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });

  it('200 — admin can update another user email', async () => {
    const { headers } = await authFor('admin');
    const target = await createUser({ email: 'oldemail@test.local' });

    const res = await request(app)
      .put(`/api/auth/team/${target.id}`)
      .set(headers)
      .send({ email: 'newemail@test.local' });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('newemail@test.local');
  });

  it('200 — admin can update another user role to manager', async () => {
    const { headers } = await authFor('admin');
    const target = await createUser({ role: 'viewer' });

    const res = await request(app)
      .put(`/api/auth/team/${target.id}`)
      .set(headers)
      .send({ role: 'manager' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('manager');
  });

  it('400 — invalid role value', async () => {
    const { headers } = await authFor('admin');
    const target = await createUser();

    const res = await request(app)
      .put(`/api/auth/team/${target.id}`)
      .set(headers)
      .send({ role: 'superadmin' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid role');
  });

  it('400 — cannot change own role', async () => {
    const { headers, user } = await authFor('admin');

    const res = await request(app)
      .put(`/api/auth/team/${user.id}`)
      .set(headers)
      .send({ role: 'viewer' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('You cannot change your own role');
  });

  it('409 — email already in use by another user', async () => {
    const { headers } = await authFor('admin');
    await createUser({ email: 'taken@test.local' });
    const target = await createUser({ email: 'mine@test.local' });

    const res = await request(app)
      .put(`/api/auth/team/${target.id}`)
      .set(headers)
      .send({ email: 'taken@test.local' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Email already in use by another user');
  });

  it('404 — user not found', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .put('/api/auth/team/cuid-that-does-not-exist')
      .set(headers)
      .send({ name: 'Ghost' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  it('403 — manager cannot update team members', async () => {
    const { headers } = await authFor('manager');
    const target = await createUser();

    const res = await request(app)
      .put(`/api/auth/team/${target.id}`)
      .set(headers)
      .send({ name: 'New Name' });

    expect(res.status).toBe(403);
  });

  it('500 — DB error in updateTeamMember triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    const target = await createUser({ email: 'dberror@test.local' });
    vi.spyOn(prisma.user, 'update').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .put(`/api/auth/team/${target.id}`)
      .set(headers)
      .send({ name: 'Broken' });

    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/auth/team/:id', () => {
  it('200 — admin can delete another user', async () => {
    const { headers } = await authFor('admin');
    const target = await createUser({ email: 'todelete@test.local' });

    const res = await request(app)
      .delete(`/api/auth/team/${target.id}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Team member deleted');
  });

  it('400 — cannot delete own account', async () => {
    const { headers, user } = await authFor('admin');

    const res = await request(app)
      .delete(`/api/auth/team/${user.id}`)
      .set(headers);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('You cannot delete your own account');
  });

  it('404 — user not found', async () => {
    const { headers } = await authFor('admin');

    const res = await request(app)
      .delete('/api/auth/team/cuid-that-does-not-exist')
      .set(headers);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  it('403 — manager cannot delete team members', async () => {
    const { headers } = await authFor('manager');
    const target = await createUser({ email: 'todelete@test.local' });

    const res = await request(app)
      .delete(`/api/auth/team/${target.id}`)
      .set(headers);

    expect(res.status).toBe(403);
  });

  it('500 — DB error in deleteTeamMember triggers next(err)', async () => {
    const { headers } = await authFor('admin');
    const target = await createUser({ email: 'dberror2@test.local' });
    vi.spyOn(prisma.user, 'delete').mockRejectedValueOnce(new Error('DB failure'));

    const res = await request(app)
      .delete(`/api/auth/team/${target.id}`)
      .set(headers);

    expect(res.status).toBe(500);
  });
});
