import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.ts";
import { config } from "./config.ts";
import { configureApp } from "./configure-app.ts";
import { PrismaService } from "./db/prisma.service.ts";

const app = await NestFactory.create<NestExpressApplication>(AppModule);

if (config.loginDisabled) {
  console.warn("Aviso: LOGIN_DISABLED=true. O servidor fica sem senha; nunca exponha essa porta (ex.: via ngrok).");
} else {
  if (!config.credentials) {
    console.warn(
      "Aviso: BOT_AUTH_USER/BOT_AUTH_PASS não configurados no .env. O gerador de alertas e o supervisor " +
        "não vão conseguir entrar no servidor.",
    );
  }
  const users = await app.get(PrismaService).user.count();
  if (users === 0) {
    console.warn("Aviso: nenhum usuário cadastrado, ninguém consegue entrar. Rode `npm run db:seed`.");
  }
}
configureApp(app, config.loginDisabled ? null : { machineCredentials: config.credentials });

await app.listen(config.port);
console.log(`Servidor rodando em http://localhost:${config.port}`);
