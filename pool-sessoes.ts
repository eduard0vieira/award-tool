// Pool de sessões (janelas do navegador já logadas) reaproveitadas entre
// buscas. Até `tamanho` buscas da mesma fonte (AwardTool ou SeatSpy) podem
// rodar ao mesmo tempo, uma por slot — buscas além disso esperam na fila até
// um slot liberar. Cada slot mantém sua própria sessão entre usos, igual ao
// reaproveitamento que já existia antes de virar pool (sessão só é recriada
// se a janela daquele slot foi fechada).
export class PoolSessoes<S> {
  private slots: { sessaoPromise: Promise<S> | null; ocupado: boolean }[];
  private fila: Array<() => void> = [];

  constructor(
    tamanho: number,
    private criarSessao: (headless: boolean) => Promise<S>,
    private sessaoViva: (sessao: S) => boolean,
  ) {
    this.slots = Array.from({ length: tamanho }, () => ({ sessaoPromise: null, ocupado: false }));
  }

  private async sessaoDoSlot(indice: number): Promise<S> {
    const slot = this.slots[indice]!;
    if (slot.sessaoPromise) {
      const sessao = await slot.sessaoPromise;
      if (this.sessaoViva(sessao)) return sessao;
      slot.sessaoPromise = null;
    }
    slot.sessaoPromise = this.criarSessao(false);
    return slot.sessaoPromise;
  }

  async adquirir(): Promise<{ sessao: S; indice: number }> {
    const indiceLivre = this.slots.findIndex((s) => !s.ocupado);
    if (indiceLivre === -1) {
      await new Promise<void>((resolve) => this.fila.push(resolve));
      return this.adquirir();
    }
    this.slots[indiceLivre]!.ocupado = true;
    const sessao = await this.sessaoDoSlot(indiceLivre);
    return { sessao, indice: indiceLivre };
  }

  liberar(indice: number) {
    this.slots[indice]!.ocupado = false;
    const proximo = this.fila.shift();
    if (proximo) proximo();
  }
}
