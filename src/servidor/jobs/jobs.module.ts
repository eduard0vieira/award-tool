import { Module } from "@nestjs/common";
import { JobRunner } from "./job-runner.service.ts";
import { JobStore } from "./job-store.service.ts";
import { JobsController } from "./jobs.controller.ts";

@Module({
  controllers: [JobsController],
  providers: [JobStore, JobRunner],
  exports: [JobStore, JobRunner],
})
export class JobsModule {}
