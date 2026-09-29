import { Module } from "@nestjs/common";
import { AlertsModule } from "./alerts/alerts.module.ts";
import { JobsModule } from "./jobs/jobs.module.ts";
import { SearchModule } from "./search/search.module.ts";

@Module({
  imports: [JobsModule, SearchModule, AlertsModule],
})
export class AppModule {}
