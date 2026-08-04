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
      try {
        const sessao = await slot.sessaoPromise;
        if (this.sessaoViva(sessao)) return sessao;
      } catch {
        // A criação anterior falhou (ex.: site bloqueou o acesso) — cai fora
        // do if e tenta criar de novo em vez de repetir o mesmo erro.
      }
      slot.sessaoPromise = null;
    }

    const promessa = this.criarSessao(false);
    slot.sessaoPromise = promessa;
    // Sem isso, uma falha na criação deixaria o slot preso numa promise
    // rejeitada e toda busca seguinte nele falharia igual até reiniciar.
    promessa.catch(() => {
      if (slot.sessaoPromise === promessa) slot.sessaoPromise = null;
    });
    return promessa;
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
