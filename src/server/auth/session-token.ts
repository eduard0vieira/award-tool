import crypto from "node:crypto";
import type { Credentials } from "../config.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

// The password's hash is part of what gets signed, so changing BOT_AUTH_PASS
// logs every open session out.
function signature(secret: Buffer, credentials: Credentials, expiresAt: number): string {
  const passHash = crypto.createHash("sha256").update(credentials.pass).digest("hex");
  return crypto
    .createHmac("sha256", secret)
    .update(`${expiresAt}.${credentials.user}.${passHash}`)
    .digest("base64url");
}

export function issueSession(secret: Buffer, credentials: Credentials, now = Date.now()): string {
  const expiresAt = now + SESSION_TTL_MS;
  return `${expiresAt}.${signature(secret, credentials, expiresAt)}`;
}

export function isValidSession(
  secret: Buffer,
  credentials: Credentials,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signature(secret, credentials, expiresAt));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
