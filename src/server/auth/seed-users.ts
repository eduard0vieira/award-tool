import type { PrismaClient } from "../../../generated/prisma/client.ts";
import { normalizeUsername } from "./auth.ts";
import { hashPassword } from "./passwords.ts";

export type SeedUser = { username: string; password: string };

const USERNAME = /^[a-z0-9._-]{2,32}$/;

// "eduardo:senha,thiago:vamoscomclasse". The password is everything after the
// first colon, so it may contain colons itself.
export function parseSeedUsers(raw: string | undefined): SeedUser[] {
  if (!raw?.trim()) throw new Error("SEED_USERS está vazio no .env. Formato: nome:senha,nome:senha");
  return raw.split(",").map((entry) => {
    const colon = entry.indexOf(":");
    const username = normalizeUsername(colon === -1 ? entry : entry.slice(0, colon));
    const password = colon === -1 ? "" : entry.slice(colon + 1);
    if (!USERNAME.test(username)) {
      throw new Error(`Nome de usuário inválido em SEED_USERS: "${username}". Use 2 a 32 letras minúsculas, números, ponto, hífen ou _.`);
    }
    if (!password) throw new Error(`Usuário "${username}" sem senha em SEED_USERS (formato nome:senha).`);
    return { username, password };
  });
}

// Only creates who is missing: running it again never resets a password that
// someone already changed.
export async function seedUsers(prisma: PrismaClient, users: SeedUser[]) {
  const created: string[] = [];
  const existing: string[] = [];
  for (const { username, password } of users) {
    if (await prisma.user.findUnique({ where: { username } })) {
      existing.push(username);
      continue;
    }
    await prisma.user.create({ data: { username, passwordHash: await hashPassword(password) } });
    created.push(username);
  }
  return { created, existing };
}
