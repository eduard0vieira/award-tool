import { Body, Controller, Get, HttpCode, Param, Post, Sse, type MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import { AnswerQuestionDto } from "./answer-question.dto.ts";
import { JobStore } from "./job-store.service.ts";

@Controller("api/searches/:jobId")
export class JobsController {
  constructor(private readonly jobs: JobStore) {}

  @Post("cancel")
  @HttpCode(200)
  cancel(@Param("jobId") jobId: string) {
    this.jobs.cancel(jobId);
    return { ok: true };
  }

  @Post("answer")
  @HttpCode(200)
  answer(@Param("jobId") jobId: string, @Body() body: AnswerQuestionDto) {
    this.jobs.answer(jobId, body.id, body.proceed);
    return { ok: true };
  }

  @Get("state")
  state(@Param("jobId") jobId: string) {
    return this.jobs.state(jobId);
  }

  @Sse("events")
  events(@Param("jobId") jobId: string): Observable<MessageEvent> {
    return this.jobs.stream(jobId);
  }
}
