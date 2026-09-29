import type { SecaoSeatspy } from "../../fontes/seatspy/bot-seatspy.ts";
import { registrarBusca } from "../../saidas/planilha.ts";

export type Leg = { rotulo: string; secoes: SecaoSeatspy[] };

// Recorded here rather than in each bot because this is where every source
// already converges on the same report shape. A recording failure never fails the search.
export function recordSearch(jobId: string, search: Omit<Parameters<typeof registrarBusca>[0], "busca">) {
  void registrarBusca({ ...search, busca: jobId }, (message) => console.log(`[${jobId}] ${message}`));
}
