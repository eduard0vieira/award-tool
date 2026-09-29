import type { Subject } from "rxjs";

export type JobEvent = { type: string; [field: string]: unknown };

export type WindowInfo = { current: number; total: number; start: string; end: string };

export type Question = { id: string; message: string };

export type Job = {
  status: "queued" | "running" | "done" | "error";
  progress: number;
  window?: WindowInfo;
  notice?: string;
  question?: Question | undefined;
  answer?: ((proceed: boolean) => void) | undefined;
  cancelled?: boolean;
  error?: string;
  result?: JobEvent;
  events: Subject<JobEvent>;
};

export type JobCallbacks = {
  log: (message: string) => void;
  progress: (fraction: number) => void;
  notice: (message: string) => void;
  window: (info: WindowInfo) => void;
  ask: (message: string) => Promise<boolean>;
  shouldStop: () => boolean;
};
