export interface SearchSource<TRequest extends object = object> {
  readonly id: string;
  readonly requestDto: new () => TRequest;
  start(jobId: string, request: TRequest): Promise<void>;
}

export const SEARCH_SOURCES = Symbol("SEARCH_SOURCES");

export type SearchSourceRegistry = ReadonlyMap<string, SearchSource>;
