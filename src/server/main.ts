import "dotenv/config";
import "reflect-metadata";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DATABASE_FILE, ROOT_DIR } from "../core/paths.ts";
import { config } from "./config.ts";
import { hasPendingMigrations } from "./db/pending-migrations.ts";

function npx(args: string[]) {
  execFileSync("npx", args, { cwd: ROOT_DIR, stdio: "inherit", shell: process.platform === "win32" });
}

// On every start, not in the supervisor: the notebook runs whichever supervisor
// version it booted with, and an old one would start a server on a database
// without the tables a pulled migration adds.
let migrationsPending = true;
try {
  migrationsPending = hasPendingMigrations(DATABASE_FILE, path.join(ROOT_DIR, "prisma", "migrations"));
} catch (err) {
  console.error("Não deu para conferir as migrações pendentes; rodando o prisma migrate deploy:", err);
}
if (migrationsPending) {
  // A migration comes with a schema change, and the generated client is not in
  // git: a supervisor that only restarts the server left the old client in place
  // and every search failed on the new column. Generating here, before the app
  // is imported, takes that off whichever supervisor is running.
  npx(["prisma", "generate"]);
  npx(["prisma", "migrate", "deploy"]);
}

// Imported only now: they load the Prisma client the step above may have regenerated.
const { AppModule } = await import("./app.module.ts");
const { configureApp } = await import("./configure-app.ts");
const { PrismaService } = await import("./db/prisma.service.ts");
const { parseSeedUsers, seedUsers } = await import("./auth/seed-users.ts");

const app = await NestFactory.create<NestExpressApplication>(AppModule);
const prisma = app.get(PrismaService);

// Creates only the users still missing, so leaving SEED_USERS in .env is safe.
if (process.env.SEED_USERS) {
  const { created } = await seedUsers(prisma, parseSeedUsers(process.env.SEED_USERS));
  if (created.length > 0) console.log(`Usuários criados a partir do SEED_USERS: ${created.join(", ")}.`);
}

if (config.loginDisabled) {
  console.warn("Aviso: LOGIN_DISABLED=true. O servidor fica sem senha; nunca exponha essa porta (ex.: via ngrok).");
} else {
  if (!config.credentials) {
    console.warn(
      "Aviso: BOT_AUTH_USER/BOT_AUTH_PASS não configurados no .env. O gerador de alertas e o supervisor " +
        "não vão conseguir entrar no servidor.",
    );
  }
  const users = await prisma.user.count();
  if (users === 0) {
    console.warn("Aviso: nenhum usuário cadastrado, ninguém consegue entrar. Defina SEED_USERS no .env e reinicie.");
  }
}
configureApp(app, config.loginDisabled ? null : { machineCredentials: config.credentials });

await app.listen(config.port);
console.log(`Servidor rodando em http://localhost:${config.port}`);
