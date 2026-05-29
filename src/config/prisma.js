// Process-wide PrismaClient singleton, constructed lazily so tests can set
// DATABASE_URL between module load and first DB call.
//
// Importers see `prisma` as a normal Prisma client — the proxy resolves on
// first method access (e.g. `prisma.user.findMany(...)`), at which point
// the real client is constructed and reused for the lifetime of the process.
//
// The proxy intentionally exposes property descriptors so `vi.spyOn(prisma,
// 'method')` works in tests — once a spy is installed it lives on the proxy's
// own target and shadows the underlying client until restored.

import { PrismaClient } from '@prisma/client';

let _client = null;

function getClient() {
  if (!_client) _client = new PrismaClient();
  return _client;
}

export const prisma = new Proxy(
  {},
  {
    get(target, prop, receiver) {
      // Spies/overrides installed on the proxy target take precedence so
      // `vi.spyOn(prisma, '$connect').mockResolvedValueOnce(...)` is honoured.
      if (prop in target) return Reflect.get(target, prop, receiver);
      const c = getClient();
      const v = c[prop];
      return typeof v === 'function' ? v.bind(c) : v;
    },
    has(target, prop) {
      return prop in target || prop in getClient();
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
    deleteProperty(target, prop) {
      return Reflect.deleteProperty(target, prop);
    },
    defineProperty(target, prop, descriptor) {
      return Reflect.defineProperty(target, prop, descriptor);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) return Reflect.getOwnPropertyDescriptor(target, prop);
      const c = getClient();
      let cur = c;
      while (cur) {
        const desc = Reflect.getOwnPropertyDescriptor(cur, prop);
        if (desc) {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: typeof desc.value === 'function' ? desc.value.bind(c) : c[prop],
          };
        }
        cur = Object.getPrototypeOf(cur);
      }
      return undefined;
    },
  },
);

export async function disconnectPrisma() {
  if (_client) {
    await _client.$disconnect();
    _client = null;
  }
}
