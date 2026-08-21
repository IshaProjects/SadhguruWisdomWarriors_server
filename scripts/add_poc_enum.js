import { prisma } from '../src/config/prisma.js';

async function run() {
  try {
    console.log("Updating Postgres Role enum...");
    await prisma.$executeRawUnsafe(`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'poc';`);
    console.log("Successfully updated Postgres Role enum!");
  } catch (err) {
    console.error("Postgres enum update error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
