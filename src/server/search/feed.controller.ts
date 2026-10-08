import { Controller, Sse, type MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import { SearchFeed } from "./search-feed.service.ts";

@Controller("api/feed")
export class FeedController {
  constructor(private readonly feed: SearchFeed) {}

  @Sse()
  events(): Observable<MessageEvent> {
    return this.feed.stream();
  }
}
