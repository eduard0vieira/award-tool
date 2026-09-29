import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { SessionPool } from "../core/session-pool.ts";
import { AppModule } from "./app.module.ts";
import type { Credentials } from "./config.ts";
import { configureApp } from "./configure-app.ts";
import { JobRunner } from "./jobs/job-runner.service.ts";
import { JobStore } from "./jobs/job-store.service.ts";
import { RouteRequestDto } from "./search/request-fields.ts";
import { SEARCH_SOURCES, type SearchSource } from "./search/search-source.ts";

class FakeSearchDto extends RouteRequestDto {}

// Stands in for a real source: no browser, and it waits for the test to release it.
class FakeSource implements SearchSource<FakeSearchDto> {
  readonly id = "fake";
  readonly requestDto = FakeSearchDto;
  private readonly pool = new SessionPool<object>({
    label: "fake",
    size: 1,
    createSession: async () => ({}),
    isAlive: () => true,
    closeSession: async () => {},
    idleMinutes: 0,
  });
  release: () => void = () => {};

  constructor(
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  start(jobId: string, request: FakeSearchDto) {
    return this.runner.run(this.pool, jobId, async () => {
      const job = this.jobs.callbacks(jobId);
      job.progress(0.5);
      await new Promise<void>((resolve) => (this.release = resolve));
      if (job.shouldStop()) throw new Error("stopped");
      if (request.origin === "ASK" && !(await job.ask("Continuar?"))) throw new Error("refused");
      this.jobs.complete(jobId, {
        legs: [{ label: request.origin, sections: [] }],
        partialNotice: "parcial",
        localFile: "spreadsheets/voos.csv",
      });
    });
  }
}

async function startApp(credentials: Credentials | null) {
  let fake: FakeSource | undefined;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SEARCH_SOURCES)
    .useFactory({
      factory: (runner: JobRunner, jobs: JobStore) => {
        fake = new FakeSource(runner, jobs);
        return new Map([[fake.id, fake]]);
      },
      inject: [JobRunner, JobStore],
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, credentials);
  await app.listen(0);
  return { app, url: await app.getUrl(), fake: fake! };
}

type Event = { type: string; [field: string]: unknown };

async function* readEvents(url: string): AsyncGenerator<Event> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (data) yield JSON.parse(data.slice(6)) as Event;
    }
  }
}

async function nextEvent(events: AsyncGenerator<Event>, type: string): Promise<Event> {
  for (;;) {
    const { value, done } = await events.next();
    if (done) throw new Error(`stream ended before "${type}"`);
    if (value.type === type) return value;
  }
}

async function post(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("server without auth", () => {
  let app: NestExpressApplication;
  let url: string;
  let fake: FakeSource;

  before(async () => ({ app, url, fake } = await startApp(null)));
  after(() => app.close());

  test("runs a search from request to done, streaming its events", async () => {
    const started = await post(`${url}/api/searches`, { source: "fake", origin: "gru", destination: "mia" });
    assert.equal(started.status, 200);
    const jobId = started.body.jobId as string;

    const events = readEvents(`${url}/api/searches/${jobId}/events`);
    assert.equal((await nextEvent(events, "progress")).fraction, 0.5);
    fake.release();
    const done = await nextEvent(events, "done");
    assert.deepEqual(done.legs, [{ label: "GRU", sections: [] }]);
    assert.equal((await events.next()).done, true);

    const state = await fetch(`${url}/api/searches/${jobId}/state`).then((r) => r.json());
    assert.deepEqual(state, { status: "done", progress: 0.5 });
    assert.equal((await post(`${url}/api/searches/${jobId}/cancel`)).status, 409);
    assert.equal((await post(`${url}/api/searches/${jobId}/answer`, { proceed: true })).status, 409);
  });

  test("replays the whole finished result to a late subscriber", async () => {
    const { body } = await post(`${url}/api/searches`, { source: "fake", origin: "GRU", destination: "LIS" });
    const live = readEvents(`${url}/api/searches/${body.jobId}/events`);
    await nextEvent(live, "progress");
    fake.release();
    const liveDone = await nextEvent(live, "done");
    const replayed = await nextEvent(readEvents(`${url}/api/searches/${body.jobId}/events`), "done");
    assert.deepEqual(replayed, liveDone);
  });

  test("asks the user and resumes after the answer", async () => {
    const { body } = await post(`${url}/api/searches`, { source: "fake", origin: "ASK", destination: "MIA" });
    const events = readEvents(`${url}/api/searches/${body.jobId}/events`);
    await nextEvent(events, "progress");
    fake.release();
    const question = await nextEvent(events, "question");

    const stale = await post(`${url}/api/searches/${body.jobId}/answer`, { id: "old", proceed: true });
    assert.equal(stale.status, 409);
    const answered = await post(`${url}/api/searches/${body.jobId}/answer`, { id: question.id, proceed: true });
    assert.deepEqual(answered, { status: 200, body: { ok: true } });
    assert.equal((await nextEvent(events, "answered")).proceed, true);
    await nextEvent(events, "done");
  });

  test("cancelling a running search ends it with the cancel message", async () => {
    const { body } = await post(`${url}/api/searches`, { source: "fake", origin: "GRU", destination: "MIA" });
    const events = readEvents(`${url}/api/searches/${body.jobId}/events`);
    await nextEvent(events, "progress");
    assert.equal((await post(`${url}/api/searches/${body.jobId}/cancel`)).status, 200);
    fake.release();
    const error = await nextEvent(events, "error");
    assert.equal(error.message, "Busca cancelada.");
  });

  test("rejects invalid requests with a Portuguese message in `error`", async () => {
    const missing = await post(`${url}/api/searches`, { source: "fake", destination: "MIA" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error as string, /origin é obrigatório/);

    const unknown = await post(`${url}/api/searches`, { source: "xyz", origin: "GRU", destination: "MIA" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error as string, /source desconhecida: "xyz"/);

    const withoutSource = await post(`${url}/api/searches`, { origin: "GRU", destination: "MIA" });
    assert.equal(withoutSource.status, 400);

    const alert = await post(`${url}/api/alerts`, { origin: "GRU" });
    assert.equal(alert.status, 400);
    assert.match(alert.body.error as string, /destination é obrigatório/);
  });

  test("answers 404 for a job that no longer exists", async () => {
    for (const path of ["state", "events"]) {
      const response = await fetch(`${url}/api/searches/missing/${path}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Busca não existe mais." });
    }
    assert.equal((await post(`${url}/api/searches/missing/cancel`)).status, 404);
  });
});

describe("server with auth", () => {
  const credentials = { user: "agent", pass: "secret" };
  let app: NestExpressApplication;
  let url: string;

  before(async () => ({ app, url } = await startApp(credentials)));
  after(() => app.close());

  test("guards the page, the API and the generated alerts", async () => {
    for (const path of ["/", "/api/searches/x/state", "/alerts/x.png", "/portal/index.html"]) {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 401, path);
    }
  });

  test("serves the page with the right credentials", async () => {
    const authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.pass}`).toString("base64")}`;
    const response = await fetch(`${url}/`, { headers: { authorization } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/i);
  });
});
