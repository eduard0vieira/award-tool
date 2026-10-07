import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTestDatabase } from "../db/test-database.ts";
import { verifyPassword } from "./passwords.ts";
import { parseSeedUsers, seedUsers } from "./seed-users.ts";

describe("user seed", () => {
  test("parses names and passwords, keeping colons inside the password", () => {
    assert.deepEqual(parseSeedUsers(" Thiago:vamoscomclasse,rony:a:b "), [
      { username: "thiago", password: "vamoscomclasse" },
      { username: "rony", password: "a:b " },
    ]);
  });

  test("refuses an empty list, a missing password or a bad name", () => {
    assert.throws(() => parseSeedUsers(""), /SEED_USERS está vazio/);
    assert.throws(() => parseSeedUsers("thiago"), /sem senha/);
    assert.throws(() => parseSeedUsers("ti ago:x"), /inválido/);
  });

  test("creates only missing users and never resets an existing password", async () => {
    const { prisma, cleanup } = createTestDatabase();
    try {
      assert.deepEqual(await seedUsers(prisma, parseSeedUsers("thiago:primeira")), { created: ["thiago"], existing: [] });
      const again = await seedUsers(prisma, parseSeedUsers("thiago:outra,rony:vamoscomclasse"));
      assert.deepEqual(again, { created: ["rony"], existing: ["thiago"] });
      const thiago = await prisma.user.findUniqueOrThrow({ where: { username: "thiago" } });
      assert.equal(await verifyPassword("primeira", thiago.passwordHash), true);
    } finally {
      await cleanup();
    }
  });
});
