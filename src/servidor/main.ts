import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.ts";
import { config } from "./config.ts";
import { configureApp } from "./configure-app.ts";

const app = await NestFactory.create<NestExpressApplication>(AppModule);

if (!config.credentials) {
  console.warn(
    "Aviso: BOT_AUTH_USER/BOT_AUTH_PASS não configurados no .env. O servidor fica sem senha. " +
      "Defina os dois antes de expor essa porta publicamente (ex.: via ngrok).",
  );
}
configureApp(app, config.credentials);

await app.listen(config.port);
console.log(`Servidor rodando em http://localhost:${config.port}`);
