import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, test } from "node:test";
import { safeNext } from "./auth.ts";
import { issueSession, isValidSession, SESSION_TTL_MS, sessionUserId } from "./session-token.ts";

const secret = crypto.randomBytes(32);
const user = { id: 7, passwordHash: "salt:hash" };

describe("login session token", () => {
  test("accepts its own token until it expires and names its user", () => {
    const token = issueSession(secret, user, 1_000);
    assert.equal(sessionUserId(token), 7);
    assert.equal(isValidSession(secret, user, token, 2_000), true);
    assert.equal(isValidSession(secret, user, token, 1_000 + SESSION_TTL_MS), false);
  });

  test("rejects the token after that user's password changes, or for another user", () => {
    const token = issueSession(secret, user, 1_000);
    assert.equal(isValidSession(secret, { ...user, passwordHash: "salt:other" }, token, 2_000), false);
    assert.equal(isValidSession(secret, { ...user, id: 8 }, token, 2_000), false);
  });

  test("rejects a token signed with another secret or with a pushed expiry", () => {
    const token = issueSession(secret, user, 1_000);
    assert.equal(isValidSession(crypto.randomBytes(32), user, token, 2_000), false);
    const [, id, signature] = token.split(".");
    assert.equal(isValidSession(secret, user, `${Number.MAX_SAFE_INTEGER}.${id}.${signature}`, 2_000), false);
    for (const broken of [undefined, "", "abc", "1.x", "1.0.x", "1.-3.x"]) {
      assert.equal(isValidSession(secret, user, broken, 0), false);
    }
    assert.equal(sessionUserId("1.-3.x"), null);
  });
});

describe("login redirect target", () => {
  test("only follows paths on this site", () => {
    assert.equal(safeNext("/?tab=smiles"), "/?tab=smiles");
    for (const unsafe of ["https://evil.example", "//evil.example", "/\\evil.example", "", undefined, 3]) {
      assert.equal(safeNext(unsafe), "/");
    }
  });
});
