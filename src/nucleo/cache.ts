// Cache com validade, em memória do processo.
//
// Existe por um motivo específico: quando o Smiles bloqueia o IP no meio de uma
// varredura, a busca é refeita minutos depois e hoje recomeça do zero, gastando
// de novo o orçamento nos dias que já tinham vindo. Guardar a resposta de cada
// dia faz a segunda tentativa pedir só o que falta.
//
// Não é banco: some quando o servidor reinicia, e isso está certo. O objetivo é
// atravessar uma janela de bloqueio, não guardar histórico.
export type ItemCache<T> = { valor: T; gravadoEm: number };

export class CacheComValidade<T> {
  private readonly itens = new Map<string, ItemCache<T>>();

  constructor(
    private readonly validadeMs: number,
    // Teto de itens pra memória não crescer sem limite numa varredura de ano.
    // Ao estourar, sai o mais antigo gravado.
    private readonly maximo = 5000,
  ) {}

  buscar(chave: string): T | null {
    const item = this.itens.get(chave);
    if (!item) return null;
    if (Date.now() - item.gravadoEm > this.validadeMs) {
      this.itens.delete(chave);
      return null;
    }
    return item.valor;
  }

  guardar(chave: string, valor: T): void {
    if (this.itens.size >= this.maximo) {
      const maisAntiga = this.itens.keys().next().value;
      if (maisAntiga !== undefined) this.itens.delete(maisAntiga);
    }
    this.itens.set(chave, { valor, gravadoEm: Date.now() });
  }

  get tamanho(): number {
    return this.itens.size;
  }
}
