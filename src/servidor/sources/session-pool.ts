import type { Provider } from "@nestjs/common";
import { PoolSessoes, type OpcoesPool } from "../../nucleo/pool-sessoes.ts";
import { config } from "../config.ts";

export function sessionPoolProvider<S>(token: symbol, options: Omit<OpcoesPool<S>, "minutosOcioso">): Provider {
  return {
    provide: token,
    useFactory: () => new PoolSessoes<S>({ ...options, minutosOcioso: config.idleMinutes }),
  };
}
