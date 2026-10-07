import crypto from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export type SessionUser = { id: number; passwordHash: string };

// The stored password hash is part of what gets signed, so changing someone's
// password logs out only that person's sessions.
function signature(secret: Buffer, user: SessionUser, expiresAt: number): string {
  return crypto.createHmac("sha256", secret).update(`${expiresAt}.${user.id}.${user.passwordHash}`).digest("base64url");
}

export function issueSession(secret: Buffer, user: SessionUser, now = Date.now()): string {
  const expiresAt = now + SESSION_TTL_MS;
  return `${expiresAt}.${user.id}.${signature(secret, user, expiresAt)}`;
}

// Only reads the token; whether it is still valid depends on the user's
// current password hash, which the caller looks up by this id.
export function sessionUserId(token: string | undefined): number | null {
  const [expiresAt, userId, sig] = (token ?? "").split(".");
  if (!expiresAt || !userId || !sig) return null;
  const id = Number(userId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function isValidSession(secret: Buffer, user: SessionUser, token: string | undefined, now = Date.now()): boolean {
  const [expiresAtText, userId, sig] = (token ?? "").split(".");
  if (!expiresAtText || !userId || !sig || Number(userId) !== user.id) return false;
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const given = Buffer.from(sig);
  const expected = Buffer.from(signature(secret, user, expiresAt));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
