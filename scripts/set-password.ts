import "dotenv/config";
import { DATABASE_FILE } from "../src/core/paths.ts";
import { normalizeUsername } from "../src/server/auth/auth.ts";
import { hashPassword } from "../src/server/auth/passwords.ts";
import { createPrismaClient } from "../src/server/db/prisma.service.ts";

// Changes one user's password, which also logs that user out everywhere.
// Usage: npx tsx scripts/set-password.ts thiago

const MIN_LENGTH = 8;

function askHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("Rode este script num terminal interativo.");
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("Cancelado."));
          return;
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

const username = normalizeUsername(process.argv[2] ?? "");
if (!username) {
  console.error("Uso: npx tsx scripts/set-password.ts <usuário>");
  process.exit(1);
}

const prisma = createPrismaClient(DATABASE_FILE);
try {
  if (!(await prisma.user.findUnique({ where: { username } }))) {
    throw new Error(`Usuário "${username}" não existe.`);
  }
  const password = await askHidden(`Nova senha de ${username}: `);
  if (password.length < MIN_LENGTH) throw new Error(`A senha precisa de pelo menos ${MIN_LENGTH} caracteres.`);
  if ((await askHidden("Repita a senha: ")) !== password) throw new Error("As senhas não conferem.");
  await prisma.user.update({ where: { username }, data: { passwordHash: await hashPassword(password) } });
  console.log(`Senha de ${username} trocada. As sessões abertas dessa pessoa foram encerradas.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
