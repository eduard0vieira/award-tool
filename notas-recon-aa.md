# Recon AA (Etapa 0) — anotações dos endpoints

> Levantado em 2026-08-03 com Chrome real via Playwright. Estas notas viram
> comentários no bot-aa.ts quando ele for implementado (e este arquivo pode
> ser apagado depois).

## Como rodar buscas na AA (procedimento)

1. `npm run chrome` — abre uma janela do Chrome com um perfil separado
   (`~/.chrome-bot-aa`). Deixe aberta; seu Chrome normal segue funcionando ao
   lado. Precisa ser perfil separado: desde o Chrome 136 a porta de depuração
   é ignorada no perfil padrão.
2. Se der "Access Denied": feche essa janela, rode
   `bash scripts/importar-cookies-aa.sh` e reabra com `npm run chrome`.
3. Buscar normalmente pela aba American do bot.

O passo 2 é o que destrava: a Akamai barra qualquer navegador sem os cookies
dela (`_abck`, `bm_s`) — inclusive um Chrome comum, sem automação, com perfil
novo. O script leva SÓ os cookies de aa.com do seu Chrome de todo dia pro
perfil do bot. Refaça quando esses cookies expirarem e o bloqueio voltar.

## Anti-bot (Akamai)

- Chromium empacotado do Playwright: **403 imediato** em qualquer URL de /booking.
- Chrome real (`channel: "chrome"` + `--disable-blink-features=AutomationControlled`) **passa**, desde que aqueça primeiro: visitar `https://www.aa.com/` (~4s) antes de ir pro deep-link.
- `page.request.post(...)` (fora do navegador, mesmo com cookies): **403** — o TLS não é o do Chrome.
- `fetch` de dentro da página (`page.evaluate`): **200** — é o caminho pra chamar a API.

## Deep-link (funciona a frio após aquecimento)

```
https://www.aa.com/booking/search?locale=en_US&pax=1&adult=1&type=OneWay
  &searchType=Award&cabin=<CABINE>&carriers=ALL
  &slices=[{"orig":"GRU","origNearby":false,"dest":"MIA","destNearby":false,"date":"2026-09-15"}]
```
(`slices` URL-encoded). Redireciona pra `POST /booking/choose-flights/1?sid=...` (HTML).
`cabin=BUSINESS` na URL vira `"BUSINESS,FIRST"` no request interno e o carrossel
passa a mostrar preços de Business — o filtro de cabine é server-side.

## Página de resultados

- Estado completo embutido em `<script id="ng-state" type="application/json">`:
  `SearchData.itineraryResult.slices[]` (itinerários do dia: `stops`,
  `segments[]`, `pricingDetail[]` com as 4 cabines — `productType`
  COACH/PREMIUM_ECONOMY/BUSINESS/FIRST, `perPassengerAwardPoints`,
  `productAvailable`) e `SearchData.weeklyResult.days[]` (carrossel ±6 dias:
  `date`, `awardPointsTotal`).
- Banner de cookies (OneTrust) pode cobrir a página — dispensar com "Reject All".
- Botão "CALENDAR" abre o calendário mensal → dispara o XHR abaixo.

## API do calendário (o coração do bot)

`POST https://www.aa.com/booking/api/search/calendar` — **sem estado de
sessão** (`sessionId`/`solutionSet` vazios funcionam; qualquer `departureDate`
serve, o mês retornado é o do departureDate). Body:

```json
{
  "metadata": { "selectedProducts": [], "tripType": "OneWay", "udo": {} },
  "passengers": [{ "type": "adult", "count": 1 }],
  "requestHeader": { "clientId": "AAcom" },
  "slices": [{
    "allCarriers": true,
    "cabin": "BUSINESS,FIRST",      // "" = todas | "COACH" | "PREMIUM_ECONOMY" | "BUSINESS,FIRST"
    "departureDate": "2026-09-15",
    "destination": "MIA", "destinationNearbyAirports": false,
    "maxStops": null,               // 0 = só voo direto (a confirmar em rota sem direto)
    "origin": "GRU", "originNearbyAirports": false
  }],
  "tripOptions": { "corporateBooking": false, "fareType": "Lowest", "locale": "en_US",
    "pointOfSale": null, "searchType": "Award", "enableBenefits": true },
  "loyaltyInfo": null, "version": "",
  "queryParams": { "sliceIndex": 0, "sessionId": "", "solutionSet": "", "solutionId": "" }
}
```

Resposta: `calendarMonths[0] = { month, year, weeks[] }`; cada
`weeks[].days[]` = `{ date, dayOfMonth, validDay, solution }` com
`solution.perPassengerAwardPoints` (menor valor do dia pra cabine pedida;
`solution: null` = sem disponibilidade). `calendarDetails.lowestMonthlyPrice`
= menor do mês.

## Varredura de ano (validada)

1. Aquecer home → deep-link (1 navegação; estabelece cookies Akamai).
2. 12 × `fetch` in-page no `/booking/api/search/calendar`, um por mês
   (`departureDate` = dia 15 de cada mês), com pausa entre eles.
3. Parsear `calendarMonths`. Total: ~13 requests por direção/ano.

## Pendências pra Etapa 1/2

- Confirmar `maxStops: 0` numa rota sem voo direto (no teste GRU–MIA o menor
  preço já era do direto, então o filtro não mudou nada — inconclusivo).
- Confirmar o valor de cabine da Premium Economy (`"PREMIUM_ECONOMY"` é o
  productType; o valor aceito no request pode ser outro).
- Mensagem/formato de erro de rota inexistente e de rate-limit da AA.
