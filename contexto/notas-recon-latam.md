# Recon LATAM (Etapa 0) — anotações

> Levantado em 2026-08-06 na janela do bot (Chrome real via CDP), primeiro anônimo
> e depois com a sessão logada herdada por importação de cookies.

## Resumo em uma linha

**Dinheiro**: calendário mensal completo, ~6 requisições por ano, sem login. **Milhas**:
exige login e só existe dia-a-dia — ~365 requisições por direção/ano.

## 1. Deep link (funciona)

```
https://www.latamairlines.com/br/pt/oferta-voos?origin=GRU&destination=SCL
  &outbound=2026-10-15T12:00:00.000Z&inbound=2026-10-22T12:00:00.000Z
  &adt=1&chd=0&inf=0&trip=RT&cabin=Economy&redemption=false&sort=RECOMMENDED
```

- `redemption=false` (dinheiro): abre direto, **sem login**, sem desafio anti-bot.
- `redemption=true` (milhas): **anônimo redireciona pro login**
  (`auth.latamairlines.com`). Com sessão logada, abre normalmente.

## 2. Calendário de tarifas — o endpoint bom (DINHEIRO)

```
GET /bff/web-products-searchbox/v1/calendar
    ?origin=GRU&destination=SCL&month=9&year=2026&isRoundTrip=true&extended=true
```

É este que alimenta a fita de datas da home. **`extended=true` é o que traz os preços.**
Cuidado: existe um `/bff/air-offers/v2/calendar` parecido que devolve **sempre vazio** —
não é ele.

Uma resposta traz **dois meses** e **as duas direções**:

```json
{ "disabledDays": ["2026-08-01", ...],
  "days": [ { "calendar": [
      { "month":"2026-09","direction":"OUTBOUND","minimum":{"amount":912.65,"currency":"BRL"},
        "maximum":{...},
        "detailsCalendar":[
          {"date":"2026-09-06","fare":{"amount":908.6,"roundedAmount":909,"currency":"BRL"},
           "formattedAmount":"909","percentile":0,"enabled":true,"lowPrice":true}, ...]},
      { "...direction":"INBOUND"... } ] }, { "...mês seguinte..." } ] }
```

- 30–31 dias por mês, com preço em ~26+ deles.
- **`lowPrice: true`** é exatamente o "Menor tarifa" destacado na interface — dá o filtro
  de graça, sem precisar comparar valores.
- `enabled: false` / `disabledDays` = dias no passado ou sem venda.

**Custo de um ano: ~6 requisições** (2 meses cada), já cobrindo ida e volta. Melhor que a AA.

**Só devolve BRL.** Testei `redemption=true`, `isRedemption=true`,
`currency=LOYALTY_POINTS` e `cabinType=Economy`: a resposta é idêntica, sempre em reais.
Não existe versão em milhas deste endpoint.

## 3. Milhas — só dia a dia, e logado

```
GET /bff/air-offers/v2/offers/search/redemption?adult=1&outFrom=<data>&...
```

Devolve 50 voos daquele dia, com
`summary.lowestPrice = {"currency":"LOYALTY_POINTS","amount":29307,"display":"29.307 milhas"}`.
Também tem `summary.stopOvers` (0 = direto) e `duration`.

**Uma requisição = um dia.** Um ano por direção = ~365 chamadas.

## 4. Cabeçalhos obrigatórios (senão 400)

```
accept: application/json, text/plain, */*
x-latam-application-country: br     x-latam-application-oc: br
x-latam-application-lang: pt        x-latam-application-name: xp-web-products-searchbox-lib
x-latam-client-name: xp-web-products-searchbox-lib
x-latam-request-id / x-latam-app-session-id / x-latam-track-id: uuid gerado por nós
```

## 5. Sessão logada sem senha

`bash scripts/importar-cookies.sh latamairlines.com` copia os cookies do domínio do Chrome
do usuário pro perfil do bot (mescla, não substitui — aa.com continua lá). Foi assim que a
sessão logada chegou no bot, sem credencial guardada em lugar nenhum. Refazer quando a
sessão expirar.

## 6. Anti-bot

Nenhum desafio nesta sessão, nos dois modos. O playbook da AA (janela do bot + pacing +
importação de cookies) cobre o risco.

## 7. Decisão de desenho que isso força

- **Modo dinheiro**: ano inteiro tranquilo, ~6 requisições.
- **Modo milhas**: inviável varrer o ano (365 chamadas/direção). Precisa de intervalo
  escolhido pelo usuário, ou de uma estratégia em duas fases (usar o calendário de
  dinheiro pra escolher os dias candidatos e só então consultar milhas neles).

---

## Ida e volta: o preço do PAR (levantado em 2026-08-18)

**Perna a perna dá um número errado.** Medido em GRU⇄JNB: confirmando cada
direção sozinha, 119.560 + 123.975 = **243.535 milhas**. O mesmo par comprado
junto no site: **90.302 milhas + R$ 255,69**. Não é tarifa diferente — a LATAM
precifica o par.

Esse número **não está** em `/offers/search/redemption`, que é o que o bot lia.
A tela "Combine suas milhas + dinheiro" só aparece depois de escolher um voo de
ida **e** um de volta, e o preço vem daqui:

```
POST https://www.latamairlines.com/bff/air-offers/v2/offers/redemption-options

{
  "tax": { "amount": 255.69, "currency": "BRL" },
  "redemptionOptions": [
    { "id": 1, "totalValueToPay": { "loyalty": { "amount": 90302 }, "money": { "amount": 0 } } },
    { "id": 2, ... 81272 + 469.56 },
    { "id": 3, ... 63212 + 1164.87 },
    { "id": 4, ... 45151 + 1760.89 }
  ]
}
```

**O que a tela mostra é `money.amount + tax.amount`** — conferido nas quatro
linhas: 469,56 + 255,69 = 725,25; 1.164,87 + 255,69 = 1.420,56; 1.760,89 +
255,69 = 2.016,58. E as linhas por perna da mesma tela (45.151 + R$ 68,61 e
45.151 + R$ 187,08) fecham com a opção 1: 45.151 × 2 = 90.302, e 68,61 + 187,08
= 255,69. Essas duas identidades são o teste barato de que a linha certa foi
lida.

**São quatro opções, não um preço.** É uma escada de milhas ↔ dinheiro, igual
ao `amountLevel` da Azul e ao desconto do Smiles: o módulo guarda as quatro e
deixa a escolha explícita.

Outro achado do caminho: a busca da volta reaparece como
`/offers/search/redemption?...&outOfferId=<id da ida>` — ou seja, a volta já é
precificada em função da ida escolhida.

**Custo:** cada par é um fluxo completo (deep link → escolhe ida → escolhe
volta). `LATAM_PAIRS` controla quantos (padrão 3).

Fixture: `fixtures/latam-redemption-options-real.json`.
Recon: `npm run recon:latam GRU JNB <ida> <volta>` (precisa de sessão logada).

## Como o par de teste é escolhido (2026-09-15)

A confirmação em milhas roda em 3 pares de datas. Ela não é uma varredura: é
uma **simulação de uma busca do grupo**, feita pra ver se o preço em pontos
muda ao longo do ano. Daí as regras:

1. **As duas datas têm que estar no resultado que o cartão mostra.** O par sai
   de `filtrarPorTetos(dias, tetos)`, a mesma lista que vira relatório. Antes
   ele saía do calendário cru: apareceu um print de dezembro num resultado que
   só tinha setembro, porque dezembro passava na margem (`menor + R$ 100`) mas
   não passava no teto — ficava fora do cartão e dentro do teste.
2. **Estada de 3 a 14 dias** (`LATAM_MIN_STAY` / `LATAM_MAX_STAY`).
   Ida num dia e volta no seguinte é fácil de achar e não é viagem de ninguém;
   acima de duas semanas o preço já é de outra faixa.
3. **Datas espalhadas.** Primeira passada exige 90 dias entre as idas
   (`LATAM_PAIR_DISTANCE`). Quando o resultado não tem esse alcance, a
   segunda passada pega sempre a data mais longe das já escolhidas em vez das
   mais baratas — três dias seguidos devolveriam o mesmo número três vezes.

Se nada satisfizer as regras, a confirmação não roda e o aviso diz por quê. É
melhor que devolver um print que não corresponde ao resultado.
