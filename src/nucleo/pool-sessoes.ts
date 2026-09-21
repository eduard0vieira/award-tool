// Pool de sessões (janelas do navegador já logadas) reaproveitadas entre
// buscas. Até `tamanho` buscas da mesma fonte (AwardTool ou SeatSpy) podem
// rodar ao mesmo tempo, uma por slot — buscas além disso esperam na fila até
// um slot liberar. Cada slot mantém sua própria sessão entre usos, igual ao
// reaproveitamento que já existia antes de virar pool (sessão só é recriada
// se a janela daquele slot foi fechada).
//
// Sessão parada é cara: uma do SeatSpy medida aqui fica em ~450 MB ociosa (9
// processos), e o servidor fica dias de pé. Por isso cada slot fecha a sessão
// depois de `minutosOcioso` sem uso e recria na próxima busca. Reabrir custa
// ~6s (launch + login) — pago uma vez por rajada de buscas, não por busca.
export type OpcoesPool<S> = {
  rotulo: string; // aparece nos logs de fechamento
  tamanho: number;
  criarSessao: (headless: boolean) => Promise<S>;
  sessaoViva: (sessao: S) => boolean;
  // O que "fechar" significa muda por fonte: quem tem navegador próprio fecha
  // o browser; quem usa o Chrome compartilhado fecha só a aba.
  fecharSessao: (sessao: S) => Promise<void>;
  minutosOcioso: number; // 0 desliga o fechamento por ociosidade
};

type Slot<S> = {
  sessaoPromise: Promise<S> | null;
  ocupado: boolean;
  timerOcioso: NodeJS.Timeout | null;
};

export class PoolSessoes<S> {
  private slots: Slot<S>[];
  private fila: Array<() => void> = [];

  constructor(private opcoes: OpcoesPool<S>) {
    this.slots = Array.from({ length: opcoes.tamanho }, () => ({
      sessaoPromise: null,
      ocupado: false,
      timerOcioso: null,
    }));
  }

  private async sessaoDoSlot(indice: number): Promise<S> {
    const slot = this.slots[indice]!;
    if (slot.sessaoPromise) {
      try {
        const sessao = await slot.sessaoPromise;
        if (this.opcoes.sessaoViva(sessao)) return sessao;
      } catch {
        // A criação anterior falhou (ex.: site bloqueou o acesso) — cai fora
        // do if e tenta criar de novo em vez de repetir o mesmo erro.
      }
      slot.sessaoPromise = null;
    }

    const promessa = this.opcoes.criarSessao(false);
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
    // Marcar ocupado e cancelar o timer no mesmo bloco síncrono é o que impede
    // o fechamento por ociosidade de disparar em cima de uma busca começando.
    this.cancelarFechamentoOcioso(indiceLivre);
    try {
      const sessao = await this.sessaoDoSlot(indiceLivre);
      return { sessao, indice: indiceLivre };
    } catch (err) {
      // Criar a sessão falhou (login fora do ar, site bloqueando). Liberar aqui
      // é obrigatório: quem chamou não recebeu índice nenhum, então não tem como
      // liberar depois, e o slot ficaria ocupado pra sempre — com todos ocupados,
      // as buscas seguintes esperariam na fila calada em vez de dar erro.
      this.liberar(indiceLivre);
      throw err;
    }
  }

  liberar(indice: number) {
    this.slots[indice]!.ocupado = false;
    this.armarFechamentoOcioso(indice);
    const proximo = this.fila.shift();
    if (proximo) proximo();
  }

  private armarFechamentoOcioso(indice: number) {
    const { minutosOcioso } = this.opcoes;
    // Negado em vez de `<= 0` pra NaN cair aqui: setTimeout(fn, NaN) dispara na
    // hora, e um valor inválido viraria "fecha depois de toda busca".
    if (!(minutosOcioso > 0)) return;
    const slot = this.slots[indice]!;
    this.cancelarFechamentoOcioso(indice);
    slot.timerOcioso = setTimeout(() => void this.fecharPorOciosidade(indice), minutosOcioso * 60_000);
    // Sem unref, um slot ocioso segura o processo de pé sozinho.
    slot.timerOcioso.unref();
  }

  private cancelarFechamentoOcioso(indice: number) {
    const slot = this.slots[indice]!;
    if (!slot.timerOcioso) return;
    clearTimeout(slot.timerOcioso);
    slot.timerOcioso = null;
  }

  private async fecharPorOciosidade(indice: number) {
    const slot = this.slots[indice]!;
    const { rotulo, minutosOcioso } = this.opcoes;
    slot.timerOcioso = null;
    if (slot.ocupado || !slot.sessaoPromise) return;

    // Solta a referência ANTES do await: quem chegar durante o fechamento cria
    // uma sessão nova em vez de receber a que está morrendo.
    const promessa = slot.sessaoPromise;
    slot.sessaoPromise = null;

    const sessao = await promessa.catch(() => null);
    if (sessao === null) return; // a criação tinha falhado; não há o que fechar

    try {
      await this.opcoes.fecharSessao(sessao);
      console.log(`[${rotulo}] slot ${indice} ocioso há ${minutosOcioso} min — sessão fechada.`);
    } catch (err) {
      // Sessão já morta ou navegador que não respondeu: o slot já está livre
      // pra recriar, mas o erro não some — some RAM se ele for sistemático.
      console.error(`[${rotulo}] falha ao fechar a sessão ociosa do slot ${indice}:`, err);
    }
  }
}
