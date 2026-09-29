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
  readonly id = "tap";
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
      if (request.origem === "ASK" && !(await job.ask("Continuar?"))) throw new Error("recusado");
      this.jobs.complete(jobId, {
        pernas: [{ rotulo: request.origem, secoes: [] }],
        avisoParcial: "parcial",
        arquivoLocal: "planilhas/voos.csv",
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

type Event = { tipo: string; [field: string]: unknown };

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

async function nextEvent(events: AsyncGenerator<Event>, tipo: string): Promise<Event> {
  for (;;) {
    const { value, done } = await events.next();
    if (done) throw new Error(`stream ended before "${tipo}"`);
    if (value.tipo === tipo) return value;
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
    const started = await post(`${url}/api/buscar`, { origem: "gru", destino: "mia" });
    assert.equal(started.status, 200);
    const jobId = started.body.jobId as string;

    const events = readEvents(`${url}/api/buscar/${jobId}/eventos`);
    assert.equal((await nextEvent(events, "progresso")).fracao, 0.5);
    fake.release();
    const done = await nextEvent(events, "done");
    assert.deepEqual(done.pernas, [{ rotulo: "GRU", secoes: [] }]);
    assert.equal((await events.next()).done, true);

    const state = await fetch(`${url}/api/buscar/${jobId}/estado`).then((r) => r.json());
    assert.deepEqual(state, { status: "done", progresso: 0.5 });
    assert.equal((await post(`${url}/api/buscar/${jobId}/cancelar`)).status, 409);
    assert.equal((await post(`${url}/api/buscar/${jobId}/responder`, { continuar: true })).status, 409);
  });

  test("replays the whole finished result to a late subscriber", async () => {
    const { body } = await post(`${url}/api/buscar`, { fonte: "tap", origem: "GRU", destino: "LIS" });
    const live = readEvents(`${url}/api/buscar/${body.jobId}/eventos`);
    await nextEvent(live, "progresso");
    fake.release();
    const liveDone = await nextEvent(live, "done");
    const replayed = await nextEvent(readEvents(`${url}/api/buscar/${body.jobId}/eventos`), "done");
    assert.deepEqual(replayed, liveDone);
  });

  test("asks the user and resumes after the answer", async () => {
    const { body } = await post(`${url}/api/buscar`, { origem: "ASK", destino: "MIA" });
    const events = readEvents(`${url}/api/buscar/${body.jobId}/eventos`);
    await nextEvent(events, "progresso");
    fake.release();
    const question = await nextEvent(events, "pergunta");

    const stale = await post(`${url}/api/buscar/${body.jobId}/responder`, { id: "old", continuar: true });
    assert.equal(stale.status, 409);
    const answered = await post(`${url}/api/buscar/${body.jobId}/responder`, { id: question.id, continuar: true });
    assert.deepEqual(answered, { status: 200, body: { ok: true } });
    assert.equal((await nextEvent(events, "respondida")).continuar, true);
    await nextEvent(events, "done");
  });

  test("cancelling a running search ends it with the cancel message", async () => {
    const { body } = await post(`${url}/api/buscar`, { origem: "GRU", destino: "MIA" });
    const events = readEvents(`${url}/api/buscar/${body.jobId}/eventos`);
    await nextEvent(events, "progresso");
    assert.equal((await post(`${url}/api/buscar/${body.jobId}/cancelar`)).status, 200);
    fake.release();
    const error = await nextEvent(events, "erro");
    assert.equal(error.mensagem, "Busca cancelada.");
  });

  test("rejects invalid requests with a Portuguese message in `erro`", async () => {
    const missing = await post(`${url}/api/buscar`, { destino: "MIA" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.erro as string, /origem é obrigatório/);

    const unknown = await post(`${url}/api/buscar`, { fonte: "xyz", origem: "GRU", destino: "MIA" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.erro as string, /fonte desconhecida: "xyz"/);

    const alert = await post(`${url}/api/alerta`, { origem: "GRU" });
    assert.equal(alert.status, 400);
    assert.match(alert.body.erro as string, /destino é obrigatório/);
  });

  test("answers 404 for a job that no longer exists", async () => {
    for (const path of ["estado", "eventos"]) {
      const response = await fetch(`${url}/api/buscar/missing/${path}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { erro: "Busca não existe mais." });
    }
    assert.equal((await post(`${url}/api/buscar/missing/cancelar`)).status, 404);
  });
});

describe("server with auth", () => {
  const credentials = { user: "agent", pass: "secret" };
  let app: NestExpressApplication;
  let url: string;

  before(async () => ({ app, url } = await startApp(credentials)));
  after(() => app.close());

  test("guards the page, the API and the generated alerts", async () => {
    for (const path of ["/", "/api/buscar/x/estado", "/alertas/x.png", "/portal/index.html"]) {
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
