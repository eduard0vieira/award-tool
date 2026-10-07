import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

// Same file as DATABASE_FILE in src/core/paths.ts. The CLI cannot import that
// module, and two independent settings once pointed the migrations and the
// server at different files.
const databaseFile = path.join(import.meta.dirname, "data", "bot.db");
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: `file:${databaseFile}`,
  },
});
