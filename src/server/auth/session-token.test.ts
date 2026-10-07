import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, test } from "node:test";
import { safeNext } from "./auth.ts";
import { issueSession, isValidSession, SESSION_TTL_MS } from "./session-token.ts";

const secret = crypto.randomBytes(32);
const credentials = { user: "agent", pass: "secret" };

describe("login session token", () => {
  test("accepts its own token until it expires", () => {
    const token = issueSession(secret, credentials, 1_000);
    assert.equal(isValidSession(secret, credentials, token, 2_000), true);
    assert.equal(isValidSession(secret, credentials, token, 1_000 + SESSION_TTL_MS), false);
  });

  test("rejects a token after the password changes", () => {
    const token = issueSession(secret, credentials, 1_000);
    assert.equal(isValidSession(secret, { ...credentials, pass: "new" }, token, 2_000), false);
  });

  test("rejects a token signed with another secret or with a pushed expiry", () => {
    const token = issueSession(secret, credentials, 1_000);
    assert.equal(isValidSession(crypto.randomBytes(32), credentials, token, 2_000), false);
    const [, signature] = token.split(".");
    assert.equal(isValidSession(secret, credentials, `${Number.MAX_SAFE_INTEGER}.${signature}`, 2_000), false);
    for (const broken of [undefined, "", "abc", ".x", "1.x"]) {
      assert.equal(isValidSession(secret, credentials, broken, 0), false);
    }
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
