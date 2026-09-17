// Utilitários e tipos compartilhados pelos bots (AwardTool/TAP, SeatSpy, AA).

export type OnLog = (mensagem: string) => void;
export type OnProgresso = (fracao: number) => void;
export type OnJanela = (info: {
  atual: number;
  total: number;
  inicio: string;
  fim: string;
}) => void;
// Avisos transitórios (ex.: "esperando N min por bloqueio de frequência") que
// valem a pena mostrar na tela mesmo sem ser erro nem progresso.
export type OnAviso = (mensagem: string) => void;

// Consultado nos pontos seguros de cada varredura (entre janelas, entre meses).
// Verdadeiro = pararam a busca pela tela; devolve o que já veio em vez de
// continuar gastando consulta numa fonte que ninguém está mais esperando.
export type DeveParar = () => boolean;

export type DiaFormatado = {
  data: string; // YYYY-MM-DD
  valorK: number;
  // Deep link pra emissão daquele dia, quando a fonte sabe montar um. O front
  // transforma o cartão do dia em link; sem ele o cartão continua sendo texto.
  // Não entra no `texto` de copiar: o grupo recebe datas, não URLs.
  link?: string;
};

export type SecaoRelatorio = {
  menor: number | null;
  maior: number | null;
  dias: DiaFormatado[]; // ordenados cronologicamente
  texto: string; // "Mmm YYYY: DD, DD, ..." (pra copiar)
  // Como o front formata menor/maior e os valores. Ausente = "K" (milhares de
  // milhas), que é o caso das fontes de milhas. "BRL" é usado pela LATAM, que
  // trabalha com tarifa em reais.
  unidade?: "K" | "BRL";
};

export const MESES_PT = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

export function parseValorK(valor: string): number | null {
  if (!valor || valor === "-") return null;
  const num = parseFloat(valor.replace(/K$/i, "").replace(",", "."));
  return Number.isNaN(num) ? null : num;
}

// `sufixoDe` permite anexar algo ao dia — o SeatSpy usa pra mostrar as vagas,
// saindo "Mai 2026: 01 (2), 05 (4)". Esse é o mesmo formato que o gerador de
// alertas já entende ao colar (ver parseDates no vcc-alertas-portal).
export function formatarListaPorMes(
  datas: string[],
  sufixoDe?: (data: string) => string,
): string {
  const grupos = new Map<string, string[]>();
  for (const d of datas) {
    const [ano, mes, dia] = d.split("-") as [string, string, string];
    const chave = `${ano}-${mes}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave)!.push(`${dia}${sufixoDe ? sufixoDe(d) : ""}`);
  }
  const chavesOrdenadas = Array.from(grupos.keys()).sort();
  return chavesOrdenadas
    .map((chave) => {
      const [ano, mesNum] = chave.split("-") as [string, string];
      const nomeMes = MESES_PT[parseInt(mesNum, 10) - 1];
      return `${nomeMes} ${ano}: ${grupos.get(chave)!.join(", ")}`;
    })
    .join("\n");
}

// Sites de busca costumam bloquear buscas "muito frequentes" na mesma
// conta/IP (aconteceu de verdade com o AwardTool rodando o modo agents).
// Esse limitador espaça o INÍCIO de cada busca, mesmo entre sessões
// diferentes do pool (é um limite por conta, não por sessão) — cada fonte
// tem a sua instância, com seu próprio intervalo.
export class LimitadorFrequencia {
  private proximaLiberacao = 0;

  constructor(private intervaloMinimoMs: number) {}

  async aguardarVez(): Promise<void> {
    const agora = Date.now();
    const espera = Math.max(0, this.proximaLiberacao - agora);
    this.proximaLiberacao = Math.max(agora, this.proximaLiberacao) + this.intervaloMinimoMs;
    if (espera > 0) await new Promise((resolve) => setTimeout(resolve, espera));
  }
}
