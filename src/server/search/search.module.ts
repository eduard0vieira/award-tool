import { Module } from "@nestjs/common";
import { JobsModule } from "../jobs/jobs.module.ts";
import { AaModule } from "../sources/aa/aa.module.ts";
import { AaSource } from "../sources/aa/aa.source.ts";
import { IberiaModule } from "../sources/iberia/iberia.module.ts";
import { IberiaSource } from "../sources/iberia/iberia.source.ts";
import { LatamModule } from "../sources/latam/latam.module.ts";
import { LatamSource } from "../sources/latam/latam.source.ts";
import { SeatspyModule } from "../sources/seatspy/seatspy.module.ts";
import { SeatspySource } from "../sources/seatspy/seatspy.source.ts";
import { SmilesModule } from "../sources/smiles/smiles.module.ts";
import { SmilesSource } from "../sources/smiles/smiles.source.ts";
import { TapModule } from "../sources/tap/tap.module.ts";
import { TapSource } from "../sources/tap/tap.source.ts";
import { SEARCH_SOURCES, type SearchSource } from "./search-source.ts";
import { FeedController } from "./feed.controller.ts";
import { HistoryController } from "./history.controller.ts";
import { SearchFeed } from "./search-feed.service.ts";
import { SearchHistory } from "./search-history.service.ts";
import { SearchController } from "./search.controller.ts";
import { SearchService } from "./search.service.ts";

@Module({
  imports: [JobsModule, TapModule, SeatspyModule, AaModule, IberiaModule, SmilesModule, LatamModule],
  controllers: [SearchController, HistoryController, FeedController],
  providers: [
    SearchService,
    SearchHistory,
    SearchFeed,
    {
      provide: SEARCH_SOURCES,
      useFactory: (...sources: SearchSource[]) => new Map(sources.map((source) => [source.id, source])),
      inject: [TapSource, SeatspySource, AaSource, IberiaSource, SmilesSource, LatamSource],
    },
  ],
})
export class SearchModule {}
