import crypto from "node:crypto";
import fs from "node:fs";
import { BadRequestException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { SESSION_SECRET_FILE } from "../../core/paths.ts";
import type { Credentials } from "../config.ts";
import { validateBody } from "../validation.ts";
import { LoginDto } from "./login.dto.ts";
import { issueSession, isValidSession, SESSION_TTL_MS } from "./session-token.ts";

const COOKIE = "bot_session";
const PUBLIC_PATHS = new Set(["/login", "/login.js", "/styles.css", "/favicon.svg", "/api/login", "/api/logout"]);
// A strict pattern, not a "/fonts/" prefix: "/fonts/../index.html" would pass a
// prefix check, and the static server normalizes it into the protected page.
const PUBLIC_FONT = /^\/fonts\/[a-z0-9-]+\.woff2$/;
const FAILED_LOGIN_DELAY_MS = 1000;

// Kept on disk so a restart (every update on the always-on machine) does not log
// everyone out.
export function loadSessionSecret(): Buffer {
  if (fs.existsSync(SESSION_SECRET_FILE)) {
    const secret = Buffer.from(fs.readFileSync(SESSION_SECRET_FILE, "utf8").trim(), "hex");
    if (secret.length < 32) {
      throw new Error(
        `${SESSION_SECRET_FILE} está corrompido. Apague o arquivo para gerar outro (todos vão precisar entrar de novo).`,
      );
    }
    return secret;
  }
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(SESSION_SECRET_FILE, secret.toString("hex"), { mode: 0o600 });
  return secret;
}

function safeEqual(given: string, expected: string): boolean {
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function credentialsMatch(user: string, pass: string, credentials: Credentials): boolean {
  // Both comparisons run before deciding, so timing never reveals which one failed.
  const userOk = safeEqual(user, credentials.user);
  const passOk = safeEqual(pass, credentials.pass);
  return userOk && passOk;
}

// Still accepted next to the cookie: the alert renderer and scripts/run-server.ts
// authenticate this way.
function basicAuthOk(header: string | undefined, credentials: Credentials): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const [user = "", pass = ""] = Buffer.from(header.slice(6), "base64").toString().split(":");
  return credentialsMatch(user, pass, credentials);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

// Only same-site paths: an absolute or protocol-relative `next` would turn the
// login page into an open redirect.
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : "/";
}

export function createAuth(credentials: Credentials, secret: Buffer) {
  const cookie = (req: Request, value: string, maxAgeSeconds: number) => {
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
  };

  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (
      PUBLIC_PATHS.has(req.path) ||
      PUBLIC_FONT.test(req.path) ||
      basicAuthOk(req.headers.authorization, credentials) ||
      isValidSession(secret, credentials, readCookie(req, COOKIE))
    ) {
      next();
      return;
    }
    if (req.method === "GET" && !req.path.startsWith("/api/")) {
      res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    res.status(401).json({ error: "Sessão expirada ou ausente. Entre de novo." });
  };

  const login = async (req: Request, res: Response) => {
    let body: LoginDto;
    try {
      body = await validateBody(LoginDto, req.body);
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      res.status(400).json({ error: err.message });
      return;
    }
    if (!credentialsMatch(body.user, body.pass, credentials)) {
      await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
      res.status(401).json({ error: "Usuário ou senha incorretos." });
      return;
    }
    res.setHeader("Set-Cookie", cookie(req, issueSession(secret, credentials), SESSION_TTL_MS / 1000));
    res.json({ ok: true });
  };

  const logout = (req: Request, res: Response) => {
    res.setHeader("Set-Cookie", cookie(req, "", 0));
    res.json({ ok: true });
  };

  return { guard, login, logout };
}
