function readIdleMinutes(): number {
  const raw = process.env.IDLE_MINUTES;
  if (raw === undefined || raw.trim() === "") return 10;
  const minutes = Number(raw);
  // "dez" would become NaN and the idle timer would fire immediately: every
  // search would pay the session reopen with nothing in the log saying why.
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`IDLE_MINUTES inválido: "${raw}". Use minutos (ex.: 10) ou 0 para desligar.`);
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
  answerTimeoutMs: Number(process.env.ANSWER_TIMEOUT_MS) || 15 * 60_000,
  latamPairs: Number(process.env.LATAM_PAIRS) || 3,
  concurrency: {
    awardtool: Number(process.env.AWARDTOOL_CONCURRENCY) || 3,
    seatspy: Number(process.env.SEATSPY_CONCURRENCY) || 3,
    // AA, LATAM and Smiles share the user's real Chrome and Akamai watches the IP.
    aa: Number(process.env.AA_CONCURRENCY) || 2,
    latam: Number(process.env.LATAM_CONCURRENCY) || 2,
    smiles: Number(process.env.SMILES_CONCURRENCY) || 2,
    // Iberia's login drops within minutes and the site has already cut a burst once.
    iberia: Number(process.env.IBERIA_CONCURRENCY) || 1,
  },
};
