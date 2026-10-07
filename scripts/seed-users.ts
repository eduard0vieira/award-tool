import "dotenv/config";
import { DATABASE_FILE } from "../src/core/paths.ts";
import { parseSeedUsers, seedUsers } from "../src/server/auth/seed-users.ts";
import { createPrismaClient } from "../src/server/db/prisma.service.ts";

// Creates the users listed in SEED_USERS (.env) that do not exist yet.
// Usage: npm run db:seed

const prisma = createPrismaClient(DATABASE_FILE);
try {
  const { created, existing } = await seedUsers(prisma, parseSeedUsers(process.env.SEED_USERS));
  console.log(created.length ? `Criados: ${created.join(", ")}.` : "Nenhum usuário novo.");
  if (existing.length) console.log(`Já existiam (senha mantida): ${existing.join(", ")}.`);
} finally {
  await prisma.$disconnect();
}
