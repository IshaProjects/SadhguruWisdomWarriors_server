# Testing guide (Vitest + in-memory Mongo)

This server is plain-JS ESM, Express + Mongoose. Tests run on **Vitest** with **v8 coverage**,
against an **in-memory MongoDB** (`mongodb-memory-server`) — no real database is ever touched.

## Running

```bash
npx vitest run                              # all tests
npx vitest run test/controllers/auth.test.js # one file
npx vitest run --coverage                   # all + coverage table
```

Per-file coverage: run `npx vitest run --coverage <your test files>` and read the coverage table —
confirm **your owned `src/...` files show 100%** in Stmts / Branch / Funcs / Lines.

## What the harness gives you (already set up — do not modify)

`test/setup.js` runs automatically for every test file:
- Sets `NODE_ENV=test` and JWT secrets (`JWT_SECRET=test-jwt-secret`, etc.).
- `beforeAll`: boots an in-memory Mongo and `mongoose.connect`s to it.
- `afterEach`: **wipes every collection** — each test starts from an empty DB.
- `afterAll`: disconnects and stops the server.

So in a test you just import a model and create documents; cleanup is automatic.

## Helpers — `test/helpers.js`

```js
import { createUser, signAccessToken, authFor } from '../helpers.js'; // adjust ../ depth

const { user, token, headers } = await authFor('admin'); // also 'manager' | 'viewer'
// headers === { Authorization: 'Bearer <jwt>' }
```

`authFor(role)` creates a user with that role and returns an auth header for it.
`createUser(overrides)` creates a User (password is bcrypt-hashed by the model).

## Pattern A — HTTP integration (controllers / routes)

```js
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import app from '../../src/app.js';          // the bootless Express app
import Category from '../../src/models/Category.js';
import { authFor } from '../helpers.js';

describe('GET /api/categories', () => {
  it('returns seeded categories for an authed user', async () => {
    await Category.create({ name: 'News' });
    const { headers } = await authFor('viewer');
    const res = await request(app).get('/api/categories').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
```

- Protected routes use `authenticate` (needs a Bearer token) and sometimes `authorize(...roles)`.
  **Check the route file** (`src/routes/<name>.js`) to see which roles each endpoint allows, and
  cover both the allowed (2xx/4xx-from-controller) and forbidden (403) cases.
- Seed data by importing the model and calling `Model.create(...)`.

## Pattern B — direct unit test (pure utils / middleware)

```js
import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from '../../src/middleware/errorHandler.js';

it('maps a ValidationError to 400', () => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  errorHandler({ name: 'ValidationError', errors: { x: { message: 'bad' } } }, {}, res, () => {});
  expect(res.status).toHaveBeenCalledWith(400);
});
```

## Mocking external services / modules

Use `vi.mock` (hoisted to top of file). Mock anything that does network or filesystem I/O
(`services/youtubeApi.js`, `services/vertexAiService.js`, `node-cron`, `axios`, the Google SDKs):

```js
import { vi } from 'vitest';
vi.mock('../../src/services/youtubeApi.js', () => ({
  fetchSingleChannel: vi.fn(async () => ({ /* ...shape the code expects... */ })),
  getQuotaUsage: vi.fn(() => 0),
}));
```

For unit-testing the external service files *themselves*, mock the underlying client
(`vi.mock('axios')`, `vi.mock('@google-cloud/vertexai')`, `vi.mock('@google/generative-ai')`)
and assert the service builds requests / parses responses correctly.

## Conventions (please follow)

- **Mirror the source path** under `test/` (e.g. `src/controllers/foo.js` → `test/controllers/foo.test.js`).
- **Genuine assertions.** Assert real behavior and response shapes; cover **error paths** (4xx/5xx,
  thrown errors, empty/edge inputs) — not lines executed just to hit a number.
- **Target 100%** lines/branches/functions for your assigned files.
- **Do NOT modify anything under `src/`.** If a file seems untestable without a source change,
  STOP and describe the needed change in your summary — do not edit source yourself.
- **Only create/edit the test files you were assigned.** Do not touch other agents' test files or
  the shared harness (`test/setup.js`, `test/helpers.js`, `vitest.config.js`).
