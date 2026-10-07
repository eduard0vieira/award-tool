export interface SearchSource<TRequest extends object = object> {
  readonly id: string;
  readonly requestDto: new () => TRequest;
  // Every field that changes what the search returns, spelled out on purpose:
  // the validated body also carries fields that must not count (source,
  // reuseRecent). Two requests with the same identity are the same search.
  identity(request: TRequest): Record<string, unknown>;
  start(jobId: string, request: TRequest): Promise<void>;
}

export const SEARCH_SOURCES = Symbol("SEARCH_SOURCES");

export type SearchSourceRegistry = ReadonlyMap<string, SearchSource>;
