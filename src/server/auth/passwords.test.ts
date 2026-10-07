import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hashPassword, verifyPassword } from "./passwords.ts";

describe("password hashing", () => {
  test("verifies the right password and rejects others", async () => {
    const stored = await hashPassword("vamoscomclasse");
    assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
    assert.equal(await verifyPassword("vamoscomclasse", stored), true);
    assert.equal(await verifyPassword("vamoscomclass", stored), false);
  });

  test("salts every hash", async () => {
    assert.notEqual(await hashPassword("same"), await hashPassword("same"));
  });

  test("fails loudly on a malformed stored hash", async () => {
    await assert.rejects(verifyPassword("x", "not-a-hash"), /formato inválido/);
  });
});
