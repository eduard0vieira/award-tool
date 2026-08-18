# Recon Azul / TudoAzul (Fase 0) — anotações

> Levantado em 2026-08-18 com `npx tsx scripts/recon-azul.ts VCP REC`, num perfil
> de Chrome **novo em folha** (sem cookie, sem histórico, sem login).

## Resumo em uma linha

Dá pra buscar em pontos **sem login e sem reputação de perfil**, mas nenhuma chamada
nossa passa: quem tem que disparar é o próprio site. O jeito que funciona é deixar a
página fazer a requisição dela e **trocar o corpo no caminho** — e o corpo aceita
**6 datas de uma vez**, o que põe um ano em ~61 navegações por direção.

## 1. Deep link (funciona, e é o melhor achado)

```
https://www.voeazul.com.br/br/pt/home/selecao-voo
  ?c[0].ds=VCP&c[0].std=10/17/2026&c[0].as=REC
  &p[0].t=ADT&p[0].c=1&p[0].cp=false&f.dl=3&f.dr=3&cc=PTS
```

- `cc=PTS` = pontos; a data vai em **M/D/AAAA**, não ISO.
- Cai direto no resultado. **Nada foi clicado** — nem o aviso de cookies.
- Perfil zerado funciona: não precisa de conta TudoAzul nem de cookie herdado.

## 2. A sessão é gerada pela própria página

```
POST /authentication/api/authentication/v1/token   → 200, ~300 bytes
```

Sai com `authorization` vazio e volta com o token (280 chars) que as chamadas
seguintes usam. **Nenhuma credencial nossa entra nisso.** É a diferença entre este
caminho e o do projeto antigo, onde o token era colado à mão e apodrecia em horas.

## 3. Endpoint de disponibilidade — a versão do código antigo está errada

```
POST https://b2c-api.voeazul.com.br/tudoAzulReservationAvailability
     /api/tudoazul/reservation/availability/v6/availability
```

`endpoints.py` do `cheap-flights` aponta pra **v5**; o site usa **v6**. O
`azul_headers_generator.py` do mesmo repo já apontava pra v6 — ou seja, lá dentro os
dois discordavam entre si.

Headers que a aplicação define (o resto é do navegador):

| header | o que é |
|---|---|
| `authorization` | token de sessão, gerado no passo 2 |
| `ocp-apim-subscription-key` | chave pública do gateway (32 chars, vem no JS do site) |
| `device` | `novosite` |
| `culture` | `pt-BR` |

Corpo que o site manda:

```json
{"criteria":[{"departureStation":"VCP","arrivalStation":"REC",
              "std":"10/17/2026","departureDate":"2026-10-17"}],
 "passengers":[{"type":"ADT","count":"1","companionPass":false}],
 "flexibleDays":{"daysToLeft":"3","daysToRight":"3"},
 "currencyCode":"BRL"}
```

## 4. Nenhuma chamada nossa passa — e o erro engana

Testei quatro transportes, todos com os mesmos headers da chamada boa:

| transporte | resultado |
|---|---|
| `fetch` de dentro da página | `Failed to fetch` |
| `XMLHttpRequest` de dentro da página | erro de rede |
| `fetch` de um iframe novo (sem o embrulho anti-bot do site) | `Failed to fetch` |
| requisição do Playwright (fora do JS da página) | **403 com página HTML de bloqueio** |

O console diz *"blocked by CORS policy: No 'Access-Control-Allow-Origin'"*, o que
manda pro caminho errado. **Não é CORS.** A quarta linha mostra o que acontece de
verdade: a requisição é barrada por anti-bot e devolve uma página de bloqueio — que,
por ser HTML de erro, não traz cabeçalho de CORS. O navegador então relata o sintoma,
não a causa.

Ou seja: aqui **não basta a chamada sair de dentro do navegador**, como bastou no
Smiles. Só passa a requisição que o próprio site montou.

## 5. O que funciona: sequestrar o corpo

Interceptar a requisição do site e substituir só o `postData`:

```ts
await page.route("**/availability/v*/availability", (rota) =>
  rota.continue({ postData: JSON.stringify(corpo) }));
await page.goto(deepLink());
```

Resultado: **200**. A requisição continua sendo a do site, com tudo que o anti-bot
espera; só o que pedimos muda.

## 6. Quantas datas cabem numa chamada — medido

| `criteria` | resultado |
|---|---|
| 1 | 200, 1 data, 20 KB |
| 6 | **200, 6 datas, 125 KB** |
| 7, 8, 9, 10, 12 | 400 `{"notifications":["GetTripAvailabilityRequestFailed"]}` |

**Seis é o teto, e é exato.** O `chunks(…, 6)` do projeto antigo não era chute.

**Custo de um ano por direção:** ⌈365/6⌉ = **61 navegações**. Cada uma carrega a
página inteira, então é da ordem de 6–8 minutos — mais lento que AA (12 requisições)
e mais rápido que LATAM em milhas (365).

Não testei se dá pra fazer a SPA repetir a busca sem recarregar a página. Se der,
o custo cai bastante — fica como primeira otimização da Fase 1.

## 7. Forma da resposta e as armadilhas

```
data.trips[]                       um por data pedida
  .std                             a data
  .fareInformation                 {lowestPoints, highestPoints}  ← resumo barato do dia
  .journeys[]
    .identifier                    {carrierCode, flightNumber, std, sta, duration, connections}
    .fares[]
      .available, .classOfService, .cabin, .productClass {code, category, name}
      .paxPoints[]                 .amountLevel 1..5
        .levels[]                  .points {amount, discount{…}, discountedAmount},
                                   .taxesAndFees, .convenienceFee, .totalMoney
    .segments[].legs[].legInfo     {capacity, lid, sold, remainingSeats}
```

Quatro coisas que precisam de decisão explícita no módulo, não de default:

1. **`amountLevel` vai de 1 a 5** — é a escada pontos↔dinheiro. O nível 1 é o
   "tudo em pontos"; do 2 em diante entra dinheiro (`fareMoney` > 0). Comparar níveis
   diferentes é somar moedas diferentes.
2. **`points.discount.applied: true`** com `restriction: "DiscountForContactPax"`:
   o valor mostrado já vem com desconto de cliente. Existem `amount` **e**
   `discountedAmount` — os dois precisam ser guardados, senão o alerta anuncia um
   preço que nem todo passageiro consegue.
3. **`remainingSeats` é assento físico da perna** (`capacity - sold`), **não**
   assento de prêmio naquele nível de pontos. Chamar isso de "assentos disponíveis"
   no alerta seria mentira.
4. **Taxa vem partida**: `taxesAndFees` + `convenienceFee`. Somar sem dizer, ou
   mostrar só uma, muda o número que o cliente vê.

## 8. `cabin` vem `null` no doméstico

Em VCP→REC todos os `fares` vieram com `cabin: null` e `productClass.category:
"Regular"`. A distinção de cabine provavelmente só aparece em rota internacional —
**precisa ser confirmada antes de o módulo prometer filtro de cabine.**

## Fixtures

- `fixtures/azul-real.json` — uma data (a chamada original do site)
- `fixtures/azul-real-multidata.json` — seis datas (chamada sequestrada)
