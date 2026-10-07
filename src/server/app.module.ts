import { Module } from "@nestjs/common";
import { AlertsModule } from "./alerts/alerts.module.ts";
import { AuthModule } from "./auth/auth.module.ts";
import { DatabaseModule } from "./db/database.module.ts";
import { JobsModule } from "./jobs/jobs.module.ts";
import { SearchModule } from "./search/search.module.ts";

@Module({
  imports: [DatabaseModule, AuthModule, JobsModule, SearchModule, AlertsModule],
})
export class AppModule {}
