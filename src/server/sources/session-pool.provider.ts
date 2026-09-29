import type { Provider } from "@nestjs/common";
import { SessionPool, type SessionPoolOptions } from "../../core/session-pool.ts";
import { config } from "../config.ts";

export function sessionPoolProvider<S>(token: symbol, options: Omit<SessionPoolOptions<S>, "idleMinutes">): Provider {
  return {
    provide: token,
    useFactory: () => new SessionPool<S>({ ...options, idleMinutes: config.idleMinutes }),
  };
}
