import { Module } from "@nestjs/common";
import { startSeatspySession, type SeatspySession } from "../../../scrapers/seatspy/seatspy.scraper.ts";
import { config } from "../../config.ts";
import { JobsModule } from "../../jobs/jobs.module.ts";
import { sessionPoolProvider } from "../session-pool.provider.ts";
import { SeatspyRoutesController } from "./seatspy-routes.controller.ts";
import { SeatspyRoutes } from "./seatspy-routes.service.ts";
import { SEATSPY_POOL } from "./seatspy-pool.ts";
import { SeatspySource } from "./seatspy.source.ts";

@Module({
  imports: [JobsModule],
  controllers: [SeatspyRoutesController],
  providers: [
    sessionPoolProvider<SeatspySession>(SEATSPY_POOL, {
      label: "seatspy",
      size: config.concurrency.seatspy,
      createSession: (headless) => startSeatspySession(headless),
      isAlive: (session) => session.browser.isConnected() && !session.page.isClosed(),
      closeSession: (session) => session.browser.close(),
    }),
    SeatspySource,
    SeatspyRoutes,
  ],
  exports: [SeatspySource],
})
export class SeatspyModule {}
