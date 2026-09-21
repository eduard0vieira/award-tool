# Bot de Emissões — contexto do projeto

Ferramenta interna de uma agência de viagens que trabalha com emissão por milhas.
Ela varre a disponibilidade de passagens-prêmio em quatro fontes e devolve as datas
com disponibilidade dentro de um teto de milhas/preço, no formato que a gente usa
para avisar o grupo de clientes.

Sem credenciais aqui: tudo que é login mora em `.env` (chaves abaixo, valores fora).

---

## 1. O que ele faz hoje

Quatro fontes, cada uma numa aba do front:

| Fonte | O que é | Login | Como extrai |
|---|---|---|---|
| **AwardTool** (TAP) | agregador pago | sim (usuário/senha no `.env`) | navegação real na página |
| **SeatSpy** | agregador pago, 9 programas (AF, B6, BA, CX, EY, IB, KLM, QF, VIR) | sim | intercepta a resposta de rede da API interna |
| **American** | aa.com, busca de prêmio | não | `fetch` de dentro da página no endpoint de calendário |
| **LATAM** | latamairlines.com | sessão do navegador | endpoint de calendário (dinheiro) + busca real (milhas) |

Saída padronizada de todas: `menor`, `maior` e a lista de datas agrupada por mês —
`Ago 2026: 07 (9), 25 (3)` (o número entre parênteses, no SeatSpy, é a quantidade
de assentos). Esse formato existe porque é exatamente o que o gerador de alertas
já sabe interpretar.

**Volume de requisição por busca:** ~13 (uma varredura de 12 meses, um mês por
requisição), com limitador de frequência entre elas — 15s no AwardTool, 8s na
LATAM, 6s na AA.

---

## 2. Como roda hoje

**Na minha máquina, na mão.** Não tem VPS, não tem cron, não tem deploy.

```
npm run server     # tsx watch server.ts → http://localhost:5555
npm run chrome     # abre um Chrome com perfil dedicado + porta de depuração
npm run tunnel     # ngrok, quando quero disparar busca do celular
```

Eu abro o navegador em `localhost:5555`, preencho origem/destino/cabine/teto e
clico buscar. Cada busca vira um card na fila da aba, com barra de progresso
alimentada por SSE. Dá para ter várias rodando ao mesmo tempo (pool de sessões:
3 AwardTool, 3 SeatSpy, 2 AA, 2 LATAM), e trocar de aba não derruba o progresso
das outras.

O servidor tem Basic Auth (`BOT_AUTH_USER`/`BOT_AUTH_PASS`) justamente porque
quando exponho por ngrok qualquer um que achasse a URL dispararia busca nas
contas pagas.

**Stack:** TypeScript + Node (tsx, sem build), Express, Playwright. Front é HTML +
JS puro, sem framework, sem bundler — `public/index.html` + `public/app.js`.

```
src/
  fontes/                    uma pasta por programa — é onde mora o scraping
    tap/bot-tap.ts             531  AwardTool/TAP
    seatspy/bot-seatspy.ts     407  SeatSpy (9 programas)
    aa/bot-aa.ts               380  American
    latam/bot-latam.ts         532  LATAM (calendário em R$ + confirmação em milhas)
    smiles/bot-smiles.ts       629  Smiles/GOL
  nucleo/                    o que toda fonte usa
    comum.ts                    82  limitador de frequência, formatação de datas, tipos
    sessao-chrome.ts           148  um Chrome por processo (CDP ou perfil próprio)
    pool-sessoes.ts            125  reaproveita sessões logadas entre buscas
    caminhos.ts                 22  todo caminho de disco sai daqui
  saidas/                    o que vira entregável
    alertas.ts                 157  gera a imagem do alerta a partir do resultado
    planilha.ts                414  CSV + Google Sheets (uma aba por busca)
  servidor/server.ts           923  API, fila de jobs, SSE
  cli.ts                        96  busca pelo terminal, sem servidor
public/                      front (HTML + JS puro, sem bundler)
contexto/                    este documento e as notas de recon
scripts/                     recon, sondas e setup (não entram no servidor)
fixtures/                    respostas cruas das APIs, pra mexer no parser sem gastar requisição
```

**Por que assim:** uma fonte por pasta porque é a unidade em que o trabalho
acontece — quando o Smiles muda o schema, tudo que precisa mudar está num lugar
só, e nada em `nucleo/` deveria precisar saber que o Smiles existe. A dependência
só aponta pra dentro: `fontes/` e `saidas/` usam `nucleo/`, `servidor/` usa os
três, e `nucleo/` não importa ninguém.

---

## 3. Armazenamento: nenhum banco

- **Jobs em memória** — `Map<jobId, {...}>` no processo. Reiniciou o servidor,
  perdeu tudo que estava rodando.
- **Histórico de buscas no `localStorage` do navegador.** É o que me avisa
  "você já buscou esse trecho há menos de 5 dias" (importa porque as fontes pagas
  têm limite de consulta). Se eu limpar o navegador, some.
- **Imagens dos alertas em disco**, em `./alertas/<timestamp>-<classe>/`.
- Nenhum registro de o que foi enviado, quando, com qual preço, nem de resultado
  histórico por rota. **Não dá para responder "esse trecho está mais barato que
  no mês passado?"** — o dado não existe depois que fecho a aba.

---

## 4. Onde ainda entra trabalho manual (é aqui que dói)

De ponta a ponta, hoje:

1. **Eu decido quais trechos buscar** e digito um por um. Não existe lista de
   rotas monitoradas — é memória e feeling.
2. **Disparo cada busca na mão.** Um formulário por vez, por cabine. Uma varredura
   ida e volta de uma cabine leva ~2–4 min; uma rodada de trabalho são dezenas
   dessas.
3. **Leio o resultado e decido o que vira alerta.** Nenhum critério codificado:
   olho o menor valor e comparo com o que eu lembro que era normal naquele trecho.
4. **Clico "Gerar alerta"** por cabine, **baixo as imagens**, abro o WhatsApp,
   **encaminho no grupo** com a legenda. Isso é 100% manual.
5. **A LATAM nem tem botão de alerta** — o card do gerador fala "milhas + taxas"
   de um programa só e não sabe exibir R$ nem duas pernas com taxas separadas.
   Alerta de LATAM eu monto na mão no portal.
6. **Manutenção de sessão:** quando a AA ou a LATAM começam a bloquear, rodo
   `scripts/importar-cookies.sh <domínio>`, que copia os cookies daquele domínio
   do meu Chrome de todo dia para o perfil do bot.
7. **Nada deduplica contra o que já foi enviado.** Se eu buscar e alertar o mesmo
   trecho duas vezes na semana, o grupo recebe duas vezes.

**Onde está o ganho maior, na minha leitura:** os passos 1, 2 e 4. Uma lista de
rotas + varredura agendada + comparação com a rodada anterior transformaria isso
em "de manhã tem uma pasta com os alertas que valem a pena, eu reviso e encaminho".

---

## 5. Como o alerta é gerado (a parte que já automatizei)

Existe um segundo repositório, `vcc-alertas-portal` (React + Vite), que é o gerador
de imagem de alerta que a equipe usa manualmente. Em vez de reimplementar o layout
do card no bot — e virar dois templates divergindo com o tempo — eu **reuso o
portal**:

- o servidor do bot serve o `dist/` do portal em `/portal`;
- o portal ganhou uma página pública `?render`, que monta o card a partir de um
  JSON serializado no hash da URL (sem Supabase, sem login);
- `alertas.ts` abre essa página num Chromium headless, tira screenshot dos
  elementos `#render-card-N` e lê a legenda de WhatsApp pronta.

```ts
const url = `${baseUrl}/portal/?render#dados=${encodeURIComponent(JSON.stringify(rota))}`;
// ... screenshot de #render-card-0, -1 ... + #render-combo (combinações ida+volta)
// nome do arquivo igual ao download manual do portal: alerta-GRU-MIA.png
```

Resultado: o alerta do bot sai idêntico ao gerado na mão, com o mesmo nome de
arquivo. **Só o encaminhar continua manual.**

---

## 6. O que quebra, e como eu descubro

Descubro **olhando** — o card fica vermelho ou o resultado vem estranho. Não tem
log estruturado, não tem métrica, não tem alerta de falha. O que existe é
`console.log` no terminal do servidor e um aviso de resultado parcial no card.

Por frequência:

1. **Anti-bot da American (Akamai).** Foi o problema mais caro do projeto. A escada
   que eu levantei empiricamente: Chromium do Playwright → 403 na hora; Chrome real
   com flag de automação escondida + aquecimento na home → passa; requisição feita
   de fora do navegador → 403 (o TLS não é o do Chrome); `fetch` de dentro da
   página → 200. E a causa raiz final: **o Akamai bloqueia qualquer navegador que
   não tenha os cookies dele**, mesmo Chrome limpo sem automação nenhuma. Por isso
   o script de importar cookies.
2. **Sessão/cookie expirando** (LATAM principalmente). Sintoma: a fase de
   confirmação em milhas falha. Conserto: reimportar cookies.
3. **Print da LATAM falhando** (o painel de tarifa fecha ao rolar a página). Isso
   me custava a busca inteira — hoje tem fallback em camadas, o print pode falhar
   que as datas (a parte cara) sobrevivem.
4. **Servidor velho em memória.** Já me pegou duas vezes: os arquivos do front são
   lidos do disco a cada request, então a mudança de interface aparece na hora, mas
   `server.ts`/`bot-*.ts` continuam os antigos. Eu via o campo novo na tela e ele
   silenciosamente não fazia nada. Mitigado com `tsx watch` + mostrar no resultado
   o valor que foi realmente aplicado.
5. **Rota que não existe na fonte.** Ficava pendurada até dar timeout; hoje
   responde na hora com erro nomeando companhia e trecho.

Classe de bug que eu tenho medo: **falha que parece resultado vazio.** Encontrei
uma essa semana na AA — o status 400 significa tanto "esse mês ainda não está à
venda" quanto "seu pedido está errado", e o código tratava os dois igual. Um pedido
recusado pararia a varredura no primeiro mês e sairia como "nenhuma
disponibilidade", sem erro nenhum. Corrigido lendo o motivo no corpo da resposta.

---

## 7. Trechos de código que mostram a estrutura

**Tipo comum de saída** (`comum.ts`) — é o que faz as quatro fontes caberem no
mesmo front e no mesmo gerador de alerta:

```ts
export type SecaoRelatorio = {
  menor: number | null;
  maior: number | null;
  dias: { data: string; valorK: number | null; assentos?: number }[];
  texto: string;              // "Ago 2026: 07 (9), 25 (3)"
  unidade?: "K" | "BRL";      // LATAM em dinheiro; ausente = milhas
};
```

**Extração da AA** — o calendário não depende de estado de sessão, então dá para
varrer o ano trocando só a data:

```ts
const resultado = await page.evaluate(async (corpo) => {
  const res = await fetch("/booking/api/search/calendar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  return { status: res.status, texto: await res.text() };
}, corpoCalendario(params, departureDate));
```

**LATAM em duas fases** — o calendário em dinheiro é barato (6 requisições cobrem
o ano, cada resposta traz 2 meses nas duas direções) e serve para achar candidatos;
só o melhor par ida/volta é confirmado em milhas com uma busca real, que gera o
print. A premissa é que voo barato em dinheiro é voo barato em milhas.

**Pool de sessões** — cada fonte tem um pool que reaproveita a sessão logada entre
buscas, porque refazer login a cada busca é lento e chama atenção do anti-bot.
Sessão parada também custa: uma do SeatSpy medida aqui fica em ~450 MB ociosa, e o
servidor fica dias de pé. Por isso o slot fecha a sessão depois de
`OCIOSIDADE_MINUTOS` sem uso e recria na busca seguinte — reabrir custa ~6s (launch
+ login), pagos uma vez por rajada. AA, LATAM e Smiles dividem um Chrome só, então
para elas a ociosidade fecha apenas a aba.

---

## 8. Chaves de configuração (só os nomes)

```
LOGIN_URL, EMAIL_ACCOUNT, PASSWORD_ACCOUNT        # AwardTool
SEATSPY_LOGIN_URL, SEATSPY_EMAIL, SEATSPY_PASSWORD
BOT_AUTH_USER, BOT_AUTH_PASS                      # Basic Auth do servidor
CONCORRENCIA_*                                    # jobs simultâneos por fonte
OCIOSIDADE_MINUTOS                                # fecha a sessão parada (0 desliga)
*_INTERVALO_BUSCAS_MS                             # limitador de frequência
AA_CHROME_PERFIL, AA_CDP_PORTA                    # perfil/porta do Chrome do bot
```
