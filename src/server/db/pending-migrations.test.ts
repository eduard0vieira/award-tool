import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import Database from "better-sqlite3";
import { hasPendingMigrations } from "./pending-migrations.ts";

// The columns Prisma 7 creates, copied from a real data/bot.db.
const MIGRATIONS_TABLE = `CREATE TABLE "_prisma_migrations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

describe("pending migrations", () => {
  let dir: string;
  let migrations: string;
  let databaseFile: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "award-tool-migrations-"));
    migrations = path.join(dir, "migrations");
    fs.mkdirSync(path.join(migrations, "20261007151011_init"), { recursive: true });
    fs.writeFileSync(path.join(migrations, "migration_lock.toml"), 'provider = "sqlite"\n');
    databaseFile = path.join(dir, "bot.db");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const record = (name: string, finishedAt: number | null, rolledBackAt: number | null = null) => {
    const db = new Database(databaseFile);
    db.prepare(
      "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, rolled_back_at) VALUES (?, 'x', ?, ?, ?)",
    ).run(`${name}-${Math.random()}`, finishedAt, name, rolledBackAt);
    db.close();
  };

  test("runs deploy when there is no database or no migrations table yet", () => {
    assert.equal(hasPendingMigrations(databaseFile, migrations), true);
    new Database(databaseFile).close();
    assert.equal(hasPendingMigrations(databaseFile, migrations), true);
  });

  test("skips deploy once every migration folder is applied, ignoring the lock file", () => {
    const db = new Database(databaseFile);
    db.exec(MIGRATIONS_TABLE);
    db.close();
    record("20261007151011_init", Date.now());
    assert.equal(hasPendingMigrations(databaseFile, migrations), false);
  });

  test("runs deploy for a folder that is not applied yet", () => {
    fs.mkdirSync(path.join(migrations, "20261008120000_next"));
    assert.equal(hasPendingMigrations(databaseFile, migrations), true);
    record("20261008120000_next", Date.now());
    assert.equal(hasPendingMigrations(databaseFile, migrations), false);
  });

  test("runs deploy when a migration was left half done, so deploy reports it", () => {
    record("20261008120000_next", null);
    assert.equal(hasPendingMigrations(databaseFile, migrations), true);
  });
});
