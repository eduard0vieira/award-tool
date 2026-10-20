import "reflect-metadata";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { SessionPool } from "../../core/session-pool.ts";
import { AppModule } from "../app.module.ts";
import { hashPassword } from "../auth/passwords.ts";
import { configureApp } from "../configure-app.ts";
import { PrismaService } from "../db/prisma.service.ts";
import { createTestDatabase } from "../db/test-database.ts";
import { JobRunner } from "../jobs/job-runner.service.ts";
import { JobStore } from "../jobs/job-store.service.ts";
import { RouteRequestDto } from "../search/request-fields.ts";
import { SEARCH_SOURCES, type SearchSource } from "../search/search-source.ts";
import { QueueService } from "./queue.service.ts";

process.env.QUEUE_AUTORUN = "false";

class FakeSearchDto extends RouteRequestDto {}

// Each leg waits for the test to finish it: finish("GRU") ends the leg leaving GRU.
class FakeSource implements SearchSource<FakeSearchDto> {
  readonly requestDto = FakeSearchDto;
  private readonly pool = new SessionPool<object>({
    label: "fake",
    size: 3,
    createSession: async () => ({}),
    isAlive: () => true,
    closeSession: async () => {},
    idleMinutes: 0,
  });
  readonly started: string[] = [];
  private readonly gates = new Map<string, (outcome: "done" | "partial" | "error") => void>();

  constructor(
    readonly id: string,
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  identity(request: FakeSearchDto) {
    return { origin: request.origin, destination: request.destination };
  }

  start(jobId: string, request: FakeSearchDto) {
    this.started.push(`${request.origin}-${request.destination}`);
    return this.runner.run(this.pool, jobId, async () => {
      const outcome = await new Promise<"done" | "partial" | "error">((resolve) => this.gates.set(request.origin, resolve));
      if (this.jobs.get(jobId).cancelled) throw new Error("stopped");
      if (outcome === "error") throw new Error("o site caiu");
      this.jobs.complete(jobId, { legs: [], ...(outcome === "partial" ? { partialNotice: "parcial" } : {}) });
    });
  }

  async finish(origin: string, outcome: "done" | "partial" | "error" = "done") {
    for (let i = 0; i < 100 && !this.gates.has(origin); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const gate = this.gates.get(origin);
    assert.ok(gate, `no leg from ${origin} is running`);
    this.gates.delete(origin);
    gate(outcome);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("search queue", () => {
  const person = { user: "thiago", pass: "vamoscomclasse" };
  let url: string;
  let cookie: string;
  let app: NestExpressApplication;
  let queue: QueueService;
  let prisma: ReturnType<typeof createTestDatabase>["prisma"];
  let cleanup: () => Promise<void>;
  let fakes: Record<string, FakeSource>;

  before(async () => {
    const database = createTestDatabase();
    ({ prisma, cleanup } = database);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(SEARCH_SOURCES)
      .useFactory({
        factory: (runner: JobRunner, jobs: JobStore) => {
          fakes = Object.fromEntries(["smiles", "aa", "tap-calendar", "seatspy", "tap"].map((id) => [id, new FakeSource(id, runner, jobs)]));
          return new Map(Object.entries(fakes));
        },
        inject: [JobRunner, JobStore],
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app, { machineCredentials: null }, crypto.randomBytes(32));
    await app.listen(0);
    url = await app.getUrl();
    queue = app.get(QueueService);
    await prisma.user.create({ data: { username: person.user, passwordHash: await hashPassword(person.pass) } });
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(person),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });
  after(async () => {
    await app.close();
    await cleanup();
  });
  beforeEach(async () => {
    await prisma.queueItem.deleteMany();
  });

  const enqueue = async (body: Record<string, unknown>) => {
    const response = await fetch(`${url}/api/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const roundTrip = (source: string, origin: string, destination: string, extra: Record<string, unknown> = {}) => ({
    source,
    args: [origin, destination],
    label: `${source} ${origin}-${destination}`,
    legs: [
      { origin, destination, ...extra },
      { origin: destination, destination: origin, ...extra },
    ],
  });
  const statusOf = async (id: string) => (await prisma.queueItem.findUniqueOrThrow({ where: { id } })).status;

  test("runs a round trip leg by leg as the person who queued it, recorded as one card", async () => {
    const { body: item } = await enqueue(roundTrip("smiles", "GRU", "LIS"));
    const running = queue.runDue();
    await fakes.smiles!.finish("GRU");
    await fakes.smiles!.finish("LIS", "partial");
    await running;

    assert.equal(await statusOf(item.id), "partial");
    const rows = await prisma.search.findMany({ where: { groupId: item.id }, orderBy: { groupLeg: "asc" }, include: { user: true } });
    assert.deepEqual(
      rows.map((row) => [row.groupLeg, row.origin, row.status, row.user?.username, row.groupArgs]),
      [
        [0, "GRU", "done", "thiago", JSON.stringify(["GRU", "LIS"])],
        [1, "LIS", "partial", "thiago", JSON.stringify(["GRU", "LIS"])],
      ],
    );
  });

  test("runs one item at a time per browser, and others side by side", async () => {
    const first = (await enqueue(roundTrip("smiles", "GRU", "MIA"))).body;
    const second = (await enqueue({ ...roundTrip("aa", "GIG", "JFK"), legs: [{ origin: "GIG", destination: "JFK" }] })).body;
    const third = (await enqueue({ ...roundTrip("tap-calendar", "REC", "LIS"), legs: [{ origin: "REC", destination: "LIS" }] })).body;
    const fourth = (await enqueue({ ...roundTrip("seatspy", "GRU", "LHR"), legs: [{ origin: "GRU", destination: "LHR" }] })).body;
    const running = queue.runDue();
    await settle();
    // AA shares the real Chrome with Smiles; the AwardTool calendar and SeatSpy do not.
    assert.equal(await statusOf(second.id), "waiting");
    assert.equal(await statusOf(third.id), "running");
    assert.equal(await statusOf(fourth.id), "running");
    await fakes["tap-calendar"]!.finish("REC");
    await fakes.seatspy!.finish("GRU");
    await fakes.smiles!.finish("GRU");
    await fakes.smiles!.finish("MIA");
    await running;
    assert.equal(await statusOf(first.id), "done");
    assert.equal(await statusOf(second.id), "waiting");
    const next = queue.runDue();
    await fakes.aa!.finish("GIG");
    await next;
    assert.equal(await statusOf(second.id), "done");
  });

  test("leaves an item scheduled for later alone until its time", async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const { body: item } = await enqueue({ ...roundTrip("smiles", "BSB", "LIS"), runAfter: later });
    await queue.runDue();
    assert.equal(await statusOf(item.id), "waiting");
    assert.equal(new Date(item.runAfter).toISOString(), later);
  });

  test("stops at a failed leg and says why", async () => {
    const { body: item } = await enqueue(roundTrip("smiles", "CNF", "LIS"));
    const running = queue.runDue();
    await fakes.smiles!.finish("CNF", "error");
    await running;
    const row = await prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(row.status, "error");
    assert.equal(row.error, "o site caiu");
    assert.equal(await prisma.search.count({ where: { groupId: item.id } }), 1);
  });

  test("resumes after a restart at the leg that was cut", async () => {
    const { body: item } = await enqueue(roundTrip("smiles", "FOR", "LIS"));
    // What a restart in the middle of the return leaves behind.
    await prisma.queueItem.update({ where: { id: item.id }, data: { status: "running", nextLeg: 1, jobId: "gone" } });
    const row = { source: "smiles", requestKey: "k", request: "{}", groupId: item.id, groupArgs: JSON.stringify(["FOR", "LIS"]) };
    await prisma.search.create({ data: { ...row, id: crypto.randomUUID(), origin: "FOR", destination: "LIS", status: "done", groupLeg: 0, result: "{}" } });
    await prisma.search.create({ data: { ...row, id: "cut", origin: "LIS", destination: "FOR", status: "error", groupLeg: 1 } });
    await queue.onModuleInit();
    assert.equal(await statusOf(item.id), "waiting");
    const running = queue.runDue();
    await fakes.smiles!.finish("LIS");
    await running;
    assert.equal(await statusOf(item.id), "done");
    assert.equal(fakes.smiles!.started.at(-1), "LIS-FOR");

    // The history reopens the card with the leg that finished, not the one the restart cut.
    const group = (await (await fetch(`${url}/api/history/groups/${item.id}`, { headers: { cookie } })).json()) as Record<string, any>;
    assert.deepEqual(
      group.legs.map((leg: Record<string, unknown>) => [leg.leg, leg.status]),
      [
        [0, "done"],
        [1, "done"],
      ],
    );
    assert.notEqual(group.legs[1].id, "cut");
  });

  test("cancels a waiting item and a running one", async () => {
    const waiting = (await enqueue({ ...roundTrip("smiles", "POA", "LIS"), runAfter: new Date(Date.now() + 3_600_000).toISOString() })).body;
    assert.equal((await fetch(`${url}/api/queue/${waiting.id}/cancel`, { method: "POST", headers: { cookie } })).status, 200);
    assert.equal(await statusOf(waiting.id), "cancelled");

    const running = (await enqueue(roundTrip("smiles", "NAT", "LIS"))).body;
    const run = queue.runDue();
    await settle();
    await fetch(`${url}/api/queue/${running.id}/cancel`, { method: "POST", headers: { cookie } });
    await fakes.smiles!.finish("NAT");
    await run;
    assert.equal(await statusOf(running.id), "cancelled");
    assert.equal(await prisma.search.count({ where: { groupId: running.id } }), 1);
  });

  test("refuses a bad leg or a source it does not queue when the item is added", async () => {
    const bad = await enqueue({ ...roundTrip("smiles", "GRU", "LIS"), legs: [{ origin: "GRU" }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /destination/);
    const asking = await enqueue(roundTrip("tap", "GRU", "LIS"));
    assert.equal(asking.status, 400);
    assert.match(asking.body.error, /não roda buscas de "tap"/);
    assert.equal(await prisma.queueItem.count(), 0);
  });

  test("lists what is waiting with who queued it", async () => {
    await enqueue({ ...roundTrip("smiles", "SSA", "LIS"), runAfter: new Date(Date.now() + 3_600_000).toISOString() });
    const list = (await (await fetch(`${url}/api/queue`, { headers: { cookie } })).json()) as Record<string, any>[];
    assert.deepEqual(
      list.map((item) => [item.label, item.status, item.user, item.legCount]),
      [["smiles SSA-LIS", "waiting", "thiago", 2]],
    );
  });
});
