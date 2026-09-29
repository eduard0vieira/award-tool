function readIdleMinutes(): number {
  const raw = process.env.OCIOSIDADE_MINUTOS;
  if (raw === undefined || raw.trim() === "") return 10;
  const minutes = Number(raw);
  // "dez" would become NaN and the idle timer would fire immediately: every
  // search would pay the session reopen with nothing in the log saying why.
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`OCIOSIDADE_MINUTOS inválido: "${raw}". Use minutos (ex.: 10) ou 0 para desligar.`);
  }
  return minutes;
}

export type Credentials = { user: string; pass: string };

function readCredentials(): Credentials | null {
  const user = process.env.BOT_AUTH_USER;
  const pass = process.env.BOT_AUTH_PASS;
  return user && pass ? { user, pass } : null;
}

export const config = {
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 5555,
  credentials: readCredentials(),
  // Sessions idle this long are closed to give the RAM back (a SeatSpy session
  // costs ~450 MB); reopening costs ~6s once per burst of searches.
  idleMinutes: readIdleMinutes(),
  // An unanswered question holds a browser slot, so it gives up and stops the search.
  answerTimeoutMs: Number(process.env.ESPERA_RESPOSTA_MS) || 15 * 60_000,
  latamPairs: Number(process.env.LATAM_PARES) || 3,
  concurrency: {
    awardtool: Number(process.env.CONCORRENCIA_AWARDTOOL) || 3,
    seatspy: Number(process.env.CONCORRENCIA_SEATSPY) || 3,
    // AA, LATAM and Smiles share the user's real Chrome and Akamai watches the IP.
    aa: Number(process.env.CONCORRENCIA_AA) || 2,
    latam: Number(process.env.CONCORRENCIA_LATAM) || 2,
    smiles: Number(process.env.CONCORRENCIA_SMILES) || 2,
    // Iberia's login drops within minutes and the site has already cut a burst once.
    iberia: Number(process.env.CONCORRENCIA_IBERIA) || 1,
  },
};
