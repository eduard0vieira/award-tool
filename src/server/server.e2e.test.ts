import "reflect-metadata";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
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
  starts = 0;

  constructor(
    private readonly runner: JobRunner,
    private readonly jobs: JobStore,
  ) {}

  identity(request: FakeSearchDto) {
    return { origin: request.origin, destination: request.destination };
  }

  start(jobId: string, request: FakeSearchDto) {
    this.starts++;
    return this.runner.run(this.pool, jobId, async () => {
      const job = this.jobs.callbacks(jobId);
      job.progress(0.5);
      await new Promise<void>((resolve) => (this.release = resolve));
      if (job.shouldStop()) throw new Error("stopped");
      if (request.origin === "ASK" && !(await job.ask("Continuar?"))) throw new Error("refused");
      this.jobs.complete(jobId, {
        legs: [{ label: request.origin, sections: [] }],
        localFile: "spreadsheets/voos.csv",
        ...(request.origin === "PRT" ? { partialNotice: "parcial" } : {}),
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

async function* readEvents(url: string, cookie?: string, signal?: AbortSignal): AsyncGenerator<Event> {
  const response = await fetch(url, { ...(cookie ? { headers: { cookie } } : {}), ...(signal ? { signal } : {}) });
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

  test("tells a late subscriber that a running search has already started", async () => {
    const { body } = await post(`${url}/api/searches`, { source: "fake", origin: "GRU", destination: "OPO" });
    await nextEvent(readEvents(`${url}/api/searches/${body.jobId}/events`), "progress");
    const late = readEvents(`${url}/api/searches/${body.jobId}/events`);
    const first = (await late.next()).value?.type;
    fake.release();
    await nextEvent(late, "done");
    assert.equal(first, "started");
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
  const colleague = { user: "rony", pass: "vamoscomclasse" };
  let url: string;
  let fake: FakeSource;
  let prisma: Awaited<ReturnType<typeof startApp>>["prisma"];
  let stop: () => Promise<void>;

  before(async () => {
    ({ url, fake, prisma, stop } = await startApp({ machineCredentials: machine }));
    for (const who of [person, colleague]) {
      await prisma.user.create({ data: { username: who.user, passwordHash: await hashPassword(who.pass) } });
    }
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
    for (const asset of ["/login.js", "/styles.css", "/fonts/barlow-400.woff2"]) {
      assert.equal((await fetch(`${url}${asset}`)).status, 200, asset);
    }
  });

  test("does not let a font path reach a protected page", async () => {
    // fetch() would normalize the "..", so the raw path goes through node:http.
    const { hostname, port } = new URL(url);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get({ hostname: hostname.replace(/^\[|\]$/g, ""), port, path: "/fonts/../index.html" }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on("error", reject);
    });
    assert.equal(status, 302);
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

  type Started = { jobId: string; joined?: { by: string | null }; reused?: { by: string | null } };
  const startSearch = async (cookie: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}/api/searches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ source: "fake", ...body }),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as Started;
  };
  const runToDone = async (cookie: string, jobId: string) => {
    const events = readEvents(`${url}/api/searches/${jobId}/events`, cookie);
    await nextEvent(events, "progress");
    fake.release();
    return nextEvent(events, "done");
  };
  const historyItem = async (cookie: string, id: string, status: string) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const items = (await fetch(`${url}/api/history`, { headers: { cookie } }).then((r) => r.json())) as {
        id: string;
        status: string;
      }[];
      const item = items.find((entry) => entry.id === id);
      if (item?.status === status) return item as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`search ${id} never reached "${status}" in the history`);
  };

  test("records every search in the shared history with who ran it", async () => {
    const cookie = await sessionCookie();
    const { jobId } = await startSearch(cookie, { origin: "GRU", destination: "AAA" });
    await runToDone(cookie, jobId);

    const item = await historyItem(cookie, jobId, "done");
    assert.equal(item.user, "thiago");
    assert.equal(item.source, "fake");
    assert.deepEqual(item.request, { origin: "GRU", destination: "AAA" });
    assert.equal("result" in item, false);

    const full = await fetch(`${url}/api/history/${jobId}`, { headers: { cookie } }).then((r) => r.json());
    assert.deepEqual(full.result.legs, [{ label: "GRU", sections: [] }]);
    assert.equal((await fetch(`${url}/api/history/missing`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${url}/api/history?limit=0`, { headers: { cookie } })).status, 400);
  });

  test("joins an identical search that is already running instead of starting another", async () => {
    const cookie = await sessionCookie();
    const before = fake.starts;
    const first = await startSearch(cookie, { origin: "GRU", destination: "BBB" });
    const second = await startSearch(cookie, { origin: "gru", destination: "bbb" });
    assert.equal(second.jobId, first.jobId);
    assert.deepEqual(second.joined, { by: "thiago" });
    assert.equal(fake.starts, before + 1);
    await runToDone(cookie, first.jobId);
  });

  test("reuses a recent identical result only when asked, without searching again", async () => {
    const cookie = await sessionCookie();
    const { jobId } = await startSearch(cookie, { origin: "GRU", destination: "CCC" });
    await runToDone(cookie, jobId);
    await historyItem(cookie, jobId, "done");
    const before = fake.starts;

    const reused = await startSearch(cookie, { origin: "GRU", destination: "CCC", reuseRecent: true });
    assert.notEqual(reused.jobId, jobId);
    assert.equal(reused.reused?.by, "thiago");
    assert.equal(fake.starts, before);
    const events = readEvents(`${url}/api/searches/${reused.jobId}/events`, cookie);
    assert.match(String((await nextEvent(events, "notice")).message), /Resultado de uma busca de thiago/);
    assert.deepEqual((await nextEvent(events, "done")).legs, [{ label: "GRU", sections: [] }]);

    const fresh = await startSearch(cookie, { origin: "GRU", destination: "CCC" });
    assert.equal(fresh.reused, undefined);
    assert.equal(fake.starts, before + 1);
    await runToDone(cookie, fresh.jobId);
  });

  test("records a cancelled search as cancelled", async () => {
    const cookie = await sessionCookie();
    const { jobId } = await startSearch(cookie, { origin: "GRU", destination: "EEE" });
    const events = readEvents(`${url}/api/searches/${jobId}/events`, cookie);
    await nextEvent(events, "progress");
    await fetch(`${url}/api/searches/${jobId}/cancel`, { method: "POST", headers: { cookie } });
    fake.release();
    await nextEvent(events, "error");
    const item = await historyItem(cookie, jobId, "cancelled");
    assert.equal(item.error, "Busca cancelada.");
  });

  test("never hands a partial result to someone asking for a recent one", async () => {
    const cookie = await sessionCookie();
    const { jobId } = await startSearch(cookie, { origin: "PRT", destination: "DDD" });
    await runToDone(cookie, jobId);
    await historyItem(cookie, jobId, "partial");

    const again = await startSearch(cookie, { origin: "PRT", destination: "DDD", reuseRecent: true });
    assert.equal(again.reused, undefined);
    await runToDone(cookie, again.jobId);
  });

  test("shows everyone else a search card as it starts, leg by leg", async () => {
    const thiago = await sessionCookie();
    const rony = await sessionCookie(colleague);
    const live = new AbortController();
    const late = new AbortController();
    try {
      const feed = readEvents(`${url}/api/feed`, rony, live.signal);
      const group = { id: "card-legs", leg: 0, args: ["GRU", "FFF", true] };
      const outbound = await startSearch(thiago, { origin: "GRU", destination: "FFF", group });
      assert.deepEqual((await nextEvent(feed, "group")).group, {
        id: "card-legs",
        source: "fake",
        args: ["GRU", "FFF", true],
        by: "thiago",
        legs: [outbound.jobId],
      });
      await runToDone(thiago, outbound.jobId);

      const inbound = await startSearch(thiago, { origin: "FFF", destination: "GRU", group: { ...group, leg: 1 } });
      assert.deepEqual((await nextEvent(feed, "group")).group, {
        id: "card-legs",
        source: "fake",
        args: ["GRU", "FFF", true],
        by: "thiago",
        legs: [outbound.jobId, inbound.jobId],
      });

      const snapshot = await nextEvent(readEvents(`${url}/api/feed`, rony, late.signal), "group");
      assert.equal(snapshot.snapshot, true);
      assert.deepEqual((snapshot.group as { legs: string[] }).legs, [outbound.jobId, inbound.jobId]);
      await runToDone(thiago, inbound.jobId);
    } finally {
      live.abort();
      late.abort();
    }
  });

  test("keeps joined and reused searches out of the feed, since they start nothing new", async () => {
    const thiago = await sessionCookie();
    const rony = await sessionCookie(colleague);
    const abort = new AbortController();
    try {
      const feed = readEvents(`${url}/api/feed`, thiago, abort.signal);
      const first = await startSearch(thiago, { origin: "GRU", destination: "GGG", group: { id: "card-first", leg: 0, args: [] } });
      assert.equal(((await nextEvent(feed, "group")).group as { id: string }).id, "card-first");
      const joined = await startSearch(rony, { origin: "GRU", destination: "GGG", group: { id: "card-joined", leg: 0, args: [] } });
      assert.equal(joined.jobId, first.jobId);
      await runToDone(thiago, first.jobId);
      await historyItem(thiago, first.jobId, "done");
      const reused = await startSearch(rony, {
        origin: "GRU",
        destination: "GGG",
        reuseRecent: true,
        group: { id: "card-reused", leg: 0, args: [] },
      });
      assert.ok(reused.reused);

      const marker = await startSearch(rony, { origin: "GRU", destination: "HHH", group: { id: "card-marker", leg: 0, args: [] } });
      assert.equal(((await nextEvent(feed, "group")).group as { id: string }).id, "card-marker");
      await runToDone(rony, marker.jobId);
    } finally {
      abort.abort();
    }
  });

  test("opens the feed saying which commit the server runs", async () => {
    const abort = new AbortController();
    try {
      const hello = (await readEvents(`${url}/api/feed`, await sessionCookie(), abort.signal).next()).value;
      assert.equal(hello?.type, "hello");
      assert.match(String(hello?.version), /^[0-9a-f]{7,}$/);
    } finally {
      abort.abort();
    }
  });

  test("refuses the feed without a session and an oversized group", async () => {
    assert.equal((await fetch(`${url}/api/feed`)).status, 401);
    const response = await fetch(`${url}/api/searches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: await sessionCookie() },
      body: JSON.stringify({ source: "fake", origin: "GRU", destination: "III", group: { id: "x", leg: 0, args: ["a".repeat(5000)] } }),
    });
    assert.equal(response.status, 400);
  });
});
