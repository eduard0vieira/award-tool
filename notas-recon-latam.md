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
