import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ROOT_DIR } from "../../core/paths.ts";
import { createPrismaClient } from "./prisma.service.ts";

// A throwaway database with the real migrations applied, so tests run against
// the same tables the server creates with `prisma migrate deploy`.
export function createTestDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "award-tool-db-"));
  const file = path.join(dir, "test.db");
  const migrationsDir = path.join(ROOT_DIR, "prisma", "migrations");
  const sqlite = new Database(file);
  for (const migration of fs.readdirSync(migrationsDir).filter((name) => /^\d/.test(name)).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, migration, "migration.sql"), "utf8"));
  }
  sqlite.close();
  const prisma = createPrismaClient(file);
  return {
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
