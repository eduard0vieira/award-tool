import "dotenv/config";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { ROOT_DIR } from "../src/core/paths.ts";

// Runs the server on the always-on machine: brings it back when it dies and
// pulls new commits from origin, restarting only when no search is running,
// since a restart loses every in-memory job. See docs/SETUP-SERVER.md.
//
// Usage: npx tsx scripts/run-server.ts

const BRANCH = process.env.DEPLOY_BRANCH || "main";
const CHECK_MS = Number(process.env.UPDATE_CHECK_MS) || 5 * 60_000;
const RESPAWN_MS = 10_000;
const PORT = process.env.PORT || "5555";
const isWindows = process.platform === "win32";

const log = (message: string) =>
  console.log(`[${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}] ${message}`);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT_DIR, encoding: "utf8" }).trim();
}

// Empty when the path is not in that commit, instead of failing like `rev-parse`.
function blobAtHead(path: string): string {
  return git("ls-tree", "HEAD", "--", path);
}

let server: ChildProcess | null = null;
let respawnTimer: NodeJS.Timeout | null = null;

function startServer() {
  respawnTimer = null;
  const child = spawn(process.execPath, ["--import", "@swc-node/register/esm-register", "src/server/main.ts"], {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });
  server = child;
  child.on("exit", (code, signal) => {
    if (child !== server) return;
    log(`O servidor parou (${code ?? signal}). Subindo de novo em ${RESPAWN_MS / 1000} s.`);
    respawnTimer = setTimeout(startServer, RESPAWN_MS);
  });
}

async function stopServer() {
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = null;
  const old = server;
  server = null;
  if (!old || old.exitCode !== null || old.signalCode !== null) return;
  const exited = new Promise((resolve) => old.once("exit", resolve));
  old.kill();
  await exited;
}

function serverAlive(): boolean {
  return server !== null && server.exitCode === null && server.signalCode === null;
}

async function activeSearches(): Promise<number | null> {
  const user = process.env.BOT_AUTH_USER;
  const pass = process.env.BOT_AUTH_PASS;
  const headers: Record<string, string> =
    user && pass ? { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` } : {};
  try {
    const response = await fetch(`http://localhost:${PORT}/api/searches/active`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log(`O servidor respondeu ${response.status} ao perguntar se há buscas rodando.`);
      return null;
    }
    const body = (await response.json()) as { active?: unknown };
    if (typeof body.active !== "number") {
      log('A resposta de /api/searches/active veio sem o campo "active".');
      return null;
    }
    return body.active;
  } catch (err) {
    log(`Não consegui perguntar ao servidor se há buscas rodando: ${errorMessage(err)}`);
    return null;
  }
}

async function checkForUpdate() {
  try {
    git("fetch", "--quiet", "origin", BRANCH);
  } catch (err) {
    log(`git fetch falhou: ${errorMessage(err)}`);
    return;
  }
  const remote = git("rev-parse", `origin/${BRANCH}`);
  if (git("rev-parse", "HEAD") === remote) return;

  // Unknown counts as busy: better a late update than a lost search.
  const active = serverAlive() ? await activeSearches() : 0;
  if (active === null) return;
  if (active > 0) {
    log(`Há código novo, mas ${active} busca(s) rodando. Atualizo quando estiver livre.`);
    return;
  }

  const lockBefore = blobAtHead("package-lock.json");
  const supervisorBefore = blobAtHead("scripts/run-server.ts");
  try {
    git("merge", "--ff-only", "--quiet", `origin/${BRANCH}`);
  } catch (err) {
    log(`Não deu para avançar para origin/${BRANCH} sem merge (há alteração local?): ${errorMessage(err)}`);
    return;
  }
  log(`Atualizado para ${remote.slice(0, 7)}: ${git("log", "-1", "--format=%s")}`);

  await stopServer();
  if (blobAtHead("package-lock.json") !== lockBefore) {
    log("As dependências mudaram. Rodando npm ci.");
    try {
      execFileSync("npm", ["ci"], { cwd: ROOT_DIR, stdio: "inherit", shell: isWindows });
    } catch (err) {
      log(`npm ci falhou: ${errorMessage(err)}. Subindo o servidor mesmo assim.`);
    }
  }
  if (blobAtHead("scripts/run-server.ts") !== supervisorBefore) {
    log("Este próprio script mudou. A versão nova só vale depois de reiniciá-lo (ou o computador).");
  }
  startServer();
}

let checking = false;
setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    await checkForUpdate();
  } catch (err) {
    log(`A verificação de atualização falhou: ${errorMessage(err)}`);
  } finally {
    checking = false;
  }
}, CHECK_MS);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await stopServer();
    process.exit(0);
  });
}

log(`Supervisor no ar. Procurando código novo em origin/${BRANCH} a cada ${Math.round(CHECK_MS / 1000)} s.`);
startServer();
