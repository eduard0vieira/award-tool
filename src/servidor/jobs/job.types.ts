import type { Subject } from "rxjs";

export type JobEvent = { tipo: string; [field: string]: unknown };

export type WindowInfo = { atual: number; total: number; inicio: string; fim: string };

export type Question = { id: string; mensagem: string };

export type Job = {
  status: "fila" | "running" | "done" | "erro";
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
