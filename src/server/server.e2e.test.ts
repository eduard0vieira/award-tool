import "reflect-metadata";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { SessionPool } from "../core/session-pool.ts";
import { AppModule } from "./app.module.ts";
import type { Credentials } from "./config.ts";
import { hashPassword } from "./auth/passwords.ts";
import { configureApp } from "./configure-app.ts";
import { PrismaService } from "./db/prisma.service.ts";
import { createTestDatabase } from "./db/test-database.ts";
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

async function startApp(login: { machineCredentials: Credentials | null } | null) {
  let fake: FakeSource | undefined;
  const database = createTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(database.prisma)
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
  configureApp(app, login, crypto.randomBytes(32));
  await app.listen(0);
  const stop = async () => {
    await app.close();
    await database.cleanup();
  };
  return { app, url: await app.getUrl(), fake: fake!, prisma: database.prisma, stop };
}

type Event = { type: string; [field: string]: unknown };

async function* readEvents(url: string, cookie?: string): AsyncGenerator<Event> {
  const response = await fetch(url, cookie ? { headers: { cookie } } : {});
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

  let stop: () => Promise<void>;

  before(async () => ({ app, url, fake, stop } = await startApp(null)));
  after(() => stop());

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

  test("counts the searches still in progress", async () => {
    const active = () => fetch(`${url}/api/searches/active`).then((r) => r.json());
    const { body } = await post(`${url}/api/searches`, { source: "fake", origin: "GRU", destination: "SCL" });
    const events = readEvents(`${url}/api/searches/${body.jobId}/events`);
    await nextEvent(events, "progress");
    assert.deepEqual(await active(), { active: 1 });
    fake.release();
    await nextEvent(events, "done");
    assert.deepEqual(await active(), { active: 0 });
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
  const machine = { user: "agent", pass: "secret" };
  const person = { user: "thiago", pass: "vamoscomclasse" };
  let url: string;
  let fake: FakeSource;
  let prisma: Awaited<ReturnType<typeof startApp>>["prisma"];
  let stop: () => Promise<void>;

  before(async () => {
    ({ url, fake, prisma, stop } = await startApp({ machineCredentials: machine }));
    await prisma.user.create({ data: { username: person.user, passwordHash: await hashPassword(person.pass) } });
  });
  after(() => stop());

  const basic = (who: { user: string; pass: string }) =>
    `Basic ${Buffer.from(`${who.user}:${who.pass}`).toString("base64")}`;
  const sessionCookie = async (who = person) => (await login(who)).headers.get("set-cookie")!.split(";")[0]!;

  const login = (body: unknown) =>
    fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("sends pages to the login and refuses the API without a session", async () => {
    for (const path of ["/", "/alerts/x.png", "/portal/index.html"]) {
      const response = await fetch(`${url}${path}`, { redirect: "manual" });
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get("location"), `/login?next=${encodeURIComponent(path)}`);
    }
    const api = await fetch(`${url}/api/searches/x/state`);
    assert.equal(api.status, 401);
    assert.match((await api.json()).error, /Entre de novo/);
    assert.equal(api.headers.get("www-authenticate"), null);
  });

  test("serves the login page and its assets without a session", async () => {
    const page = await fetch(`${url}/login`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="login-form"/);
    for (const asset of ["/login.js", "/styles.css"]) assert.equal((await fetch(`${url}${asset}`)).status, 200, asset);
  });

  test("accepts Basic only for the machine credentials, which the alert renderer uses", async () => {
    const machinePage = await fetch(`${url}/`, { headers: { authorization: basic(machine) } });
    assert.equal(machinePage.status, 200);
    assert.match(await machinePage.text(), /<html/i);
    const personPage = await fetch(`${url}/`, { headers: { authorization: basic(person) }, redirect: "manual" });
    assert.equal(personPage.status, 302);
  });

  test("rejects a wrong password, an unknown user and an incomplete body the same way", async () => {
    for (const attempt of [{ user: person.user, pass: "nope" }, { user: "ninguem", pass: person.pass }, machine]) {
      const response = await login(attempt);
      assert.equal(response.status, 401, attempt.user);
      assert.deepEqual(await response.json(), { error: "Usuário ou senha incorretos." });
      assert.equal(response.headers.get("set-cookie"), null);
    }
    assert.equal((await login({ user: person.user })).status, 400);
  });

  test("logs in with any capitalization of the name and says who is logged in", async () => {
    const cookie = await sessionCookie({ user: " Thiago ", pass: person.pass });
    assert.deepEqual(await fetch(`${url}/api/me`, { headers: { cookie } }).then((r) => r.json()), { username: "thiago" });
  });

  test("ends a user's sessions when that user's password changes", async () => {
    const cookie = await sessionCookie();
    assert.equal((await fetch(`${url}/api/me`, { headers: { cookie } })).status, 200);
    await prisma.user.update({ where: { username: person.user }, data: { passwordHash: await hashPassword("nova") } });
    assert.equal((await fetch(`${url}/api/me`, { headers: { cookie } })).status, 401);
    await prisma.user.update({ where: { username: person.user }, data: { passwordHash: await hashPassword(person.pass) } });
  });

  test("logs in with a session cookie and logs out", async () => {
    const response = await login(person);
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie")!;
    assert.match(setCookie, /^bot_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    const cookie = setCookie.split(";")[0]!;

    const page = await fetch(`${url}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const api = await fetch(`${url}/api/searches/missing/state`, { headers: { cookie } });
    assert.equal(api.status, 404);

    const logout = await fetch(`${url}/api/logout`, { method: "POST", headers: { cookie } });
    assert.match(logout.headers.get("set-cookie")!, /^bot_session=; .*Max-Age=0/);
  });

  test("still reads JSON bodies on every route once the login is on", async () => {
    const cookie = await sessionCookie();
    const started = await fetch(`${url}/api/searches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ source: "fake", origin: "GRU", destination: "MIA" }),
    });
    assert.equal(started.status, 200);
    const { jobId } = (await started.json()) as { jobId: string };
    const events = readEvents(`${url}/api/searches/${jobId}/events`, cookie);
    await nextEvent(events, "progress");
    fake.release();
    await nextEvent(events, "done");
  });

  test("marks the cookie Secure behind the https tunnel", async () => {
    const response = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify(person),
    });
    assert.match(response.headers.get("set-cookie")!, /; Secure$/);
  });
});
