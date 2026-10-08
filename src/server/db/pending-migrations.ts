import fs from "node:fs";
import Database from "better-sqlite3";

type AppliedRow = { migration_name: string; finished_at: number | string | null; rolled_back_at: number | string | null };

// `prisma migrate deploy` costs an npx start on every boot, which is slow on the
// notebook. It only needs to run when a migration folder is not applied yet;
// anything uncertain (no database, no table, a migration left half done) still
// runs it, so deploy itself reports the problem.
export function hasPendingMigrations(databaseFile: string, migrationsDir: string): boolean {
  const folders = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (!fs.existsSync(databaseFile)) return true;

  const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'").get();
    if (!table) return true;
    const rows = db.prepare("SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations").all() as AppliedRow[];
    if (rows.some((row) => row.finished_at === null && row.rolled_back_at === null)) return true;
    const applied = new Set(rows.filter((row) => row.finished_at !== null).map((row) => row.migration_name));
    return folders.some((name) => !applied.has(name));
  } finally {
    db.close();
  }
}
