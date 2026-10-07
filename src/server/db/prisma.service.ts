import fs from "node:fs";
import path from "node:path";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../../generated/prisma/client.ts";
import { DATABASE_FILE } from "../../core/paths.ts";

function clientOptions(file: string) {
  // SQLite creates the file but not its folder.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) };
}

export function createPrismaClient(file: string): PrismaClient {
  return new PrismaClient(clientOptions(file));
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super(clientOptions(DATABASE_FILE));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
