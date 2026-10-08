import fs from "node:fs";
import path from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { SEATSPY_ROUTES_FILE } from "../../../core/paths.ts";
import type { SessionPool } from "../../../core/session-pool.ts";
import { readRouteMap, type SeatspyAirline, type SeatspyRouteMap, type SeatspySession } from "../../../scrapers/seatspy/seatspy.scraper.ts";
import { SEATSPY_POOL } from "./seatspy-pool.ts";

type CachedRoutes = { fetchedAt: string; origins: SeatspyRouteMap };

// Routes change rarely; a week-old map only feeds hints, and the search itself
// still checks the live form before spending a credit.
const MAX_AGE_MS = 7 * 86_400_000;

// Kept on disk because the server restarts on every update. Every SeatSpy search
// refreshes its airline for free; a missing airline is read on demand.
@Injectable()
export class SeatspyRoutes {
  private readonly cache: Partial<Record<SeatspyAirline, CachedRoutes>> = loadCache();
  private readonly inFlight = new Map<SeatspyAirline, Promise<CachedRoutes>>();

  constructor(@Inject(SEATSPY_POOL) private readonly pool: SessionPool<SeatspySession>) {}

  get(airline: SeatspyAirline): Promise<CachedRoutes> {
    const cached = this.cache[airline];
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < MAX_AGE_MS) return Promise.resolve(cached);
    let pending = this.inFlight.get(airline);
    if (!pending) {
      pending = this.read(airline).finally(() => this.inFlight.delete(airline));
      this.inFlight.set(airline, pending);
    }
    return pending;
  }

  remember(airline: SeatspyAirline, origins: SeatspyRouteMap): CachedRoutes {
    const routes = { fetchedAt: new Date().toISOString(), origins };
    this.cache[airline] = routes;
    try {
      fs.mkdirSync(path.dirname(SEATSPY_ROUTES_FILE), { recursive: true });
      fs.writeFileSync(SEATSPY_ROUTES_FILE, JSON.stringify(this.cache));
    } catch (err) {
      console.error(`Não deu para salvar o mapa de rotas do SeatSpy em ${SEATSPY_ROUTES_FILE}:`, err);
    }
    return routes;
  }

  // Waits for a free session like a search does: on the notebook (one session)
  // that means after the search running now.
  private async read(airline: SeatspyAirline): Promise<CachedRoutes> {
    const { session, index } = await this.pool.acquire();
    try {
      return this.remember(airline, await readRouteMap(session.page, airline));
    } finally {
      this.pool.release(index);
    }
  }
}

function loadCache(): Partial<Record<SeatspyAirline, CachedRoutes>> {
  if (!fs.existsSync(SEATSPY_ROUTES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEATSPY_ROUTES_FILE, "utf8")) as Partial<Record<SeatspyAirline, CachedRoutes>>;
  } catch (err) {
    console.error(`O mapa de rotas do SeatSpy em ${SEATSPY_ROUTES_FILE} está ilegível; ele será lido de novo:`, err);
    return {};
  }
}
