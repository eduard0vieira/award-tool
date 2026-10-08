import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTestDatabase } from "../db/test-database.ts";
import type { PrismaService } from "../db/prisma.service.ts";
import { JobStore } from "../jobs/job-store.service.ts";
import { SearchFeed } from "./search-feed.service.ts";
import { SearchHistory } from "./search-history.service.ts";

const row = (id: string, status: string, createdAt = new Date()) => ({
  id,
  source: "smiles",
  origin: "GRU",
  destination: "CUN",
  requestKey: "k",
  request: "{}",
  status,
  result: '{"legs":[]}',
  createdAt,
});

describe("search history on startup", () => {
  test("marks searches cut by a restart as errors and drops old results", async () => {
    const { prisma, cleanup } = createTestDatabase();
    try {
      await prisma.search.createMany({
        data: [row("running", "running"), row("queued", "queued"), row("old", "done", new Date("2020-01-01")), row("new", "done")],
      });
      const jobs = new JobStore();
      await new SearchHistory(prisma as unknown as PrismaService, jobs, new SearchFeed(jobs)).onModuleInit();

      const byId = new Map((await prisma.search.findMany()).map((r) => [r.id, r]));
      for (const id of ["running", "queued"]) {
        assert.equal(byId.get(id)!.status, "error");
        assert.match(byId.get(id)!.error!, /reiniciou/);
      }
      assert.equal(byId.get("old")!.result, null);
      assert.equal(byId.get("old")!.status, "done");
      assert.equal(byId.get("new")!.result, '{"legs":[]}');
    } finally {
      await cleanup();
    }
  });
});
