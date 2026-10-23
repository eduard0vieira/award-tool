# Fixtures

Raw API responses, saved byte for byte, with no parsing and no transformation.

They let you work on a parser without spending requests. That matters on Smiles,
where the budget per IP is limited and every test search burns part of it (see
the 406 in `docs/CONTEXT.md`).

| file | source | how to regenerate |
|---|---|---|
| `smiles-real.json` | Smiles, GRU→MIA search | `npx tsx scripts/recon-smiles.ts` |
| `smiles-real-congener.json` | Smiles, a day that also brings congener airlines | saved by hand from a real response |
| `smiles-452-date.json` | Smiles, 452 for a date outside the sale window | saved by hand from a real response |
| `smiles-452-airport.json` | Smiles, 452 for an unknown airport | saved by hand from a real response |
| `smiles-452-upstream-503.json` | Smiles, 452 wrapping a 503 from its search backend | saved by hand from a real response |
| `smiles-452-flightlist.json` | Smiles, 452 for a crash inside its search service, gone when asked again | saved by hand from a real response |
| `smiles-406-budget.json` | Smiles, 406 from the Akamai edge when the IP is over its budget (`clientIP` anonymized) | `npx tsx scripts/measure-smiles-budget.ts GRU CUN` |
| `azul-real.json` | Azul, one date, called by the site itself | `npx tsx scripts/recon-azul.ts` |
| `azul-real-multidata.json` | Azul, six dates, hijacked call | `BATCHES=6 npx tsx scripts/recon-azul.ts` |
| `iberia-real.json` | Iberia, day availability | `npm run recon:iberia` (logged-in session) |
| `iberia-real-plus1.json`, `iberia-real-plus30.json` | Iberia, the same route 1 and 30 days later | `npm run recon:iberia` (logged-in session) |
| `iberia-monthly-0.json` | Iberia, monthly calendar | saved by hand from a real response |
| `latam-redemption-options-real.json` | LATAM, the 4 miles+cash combinations of a round-trip pair | `npm run recon:latam GRU JNB <outbound> <return>` (logged-in session) |
| `seatspy-route-options.json` | SeatSpy, not an API response: the airport options of the search form as the scraper reads them (`key`, `iata`, `iatas`, `title`), after picking the airline and GRU | `npx tsx scripts/recon-seatspy-routes.ts AF GRU MAD` and `IB GRU MAD` (logged-in session, no credit spent) |
| `seatspy-route-map-AF.json` | SeatSpy, not an API response: every Air France origin in the search form's `#outbound` options with its `destinations`, as the page holds them (DOM references removed) | `ROUTE_MAP=1 npx tsx scripts/recon-seatspy-routes.ts AF GRU MAD` (logged-in session, no credit spent) |
| `awardtool-route-calendar-GRU-LIS.json` | AwardTool, `routes_calendar_v2` for GRU-LIS (every program, one year), still in its `ciphered_data` wrapper (base64 of zlib) | `npx tsx scripts/recon-awardtool-calendar.ts GRU-LIS fixtures` (logged-in session) |
| `awardtool-panorama-BR_2-EUMAJOR_1.json` | AwardTool, the first 2-day `routes_data_v2` response of a Panorama search from Brazil to Europe, TAP only, still in its `ciphered_data` wrapper | `npx tsx scripts/recon-awardtool-panorama.ts BR_2 EUMAJOR_1 2026-12-01 fixtures` (logged-in session) |
| `google-flights-calendar-GRU-JFK.txt` | Google Flights, `GetCalendarPicker` for GRU⇄JFK, business, LATAM only, 7-day round trips, Jan–Feb 2027, raw batch format | replay of the page's own call with a 2-month range (see `src/scrapers/google-flights/google-flights.scraper.ts`) |
| `google-flights-calendar-refused.txt` | Google Flights, the same call refused for a 12-month range | same, with a 12-month range |

## Rule before committing a new fixture

Check before adding one:

- no token, cookie, `Authorization` or API key (the scripts save only the
  **response** headers, never the request ones);
- no client data (name, CPF, e-mail, loyalty number, booking).

If the response carries any of these, it stays out of git. The screenshots in
this folder come from logged-in sessions and are ignored for that reason.
