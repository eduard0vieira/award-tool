# Fixtures

Respostas cruas das APIs, salvas byte a byte, sem parse e sem transformação.

Servem pra mexer no parser sem gastar requisição — importante no Smiles, onde o
orçamento por IP é limitado e cada busca de teste queima parte dele (ver o 406 em
`CONTEXTO.md`).

| arquivo | fonte | como regerar |
|---|---|---|
| `smiles-real.json` | Smiles — busca GRU→MIA | `npx tsx scripts/recon-smiles.ts` |
| `seatsaero-real.json` | Seats.aero — API Partner | `SEATS_API_KEY=... npx tsx scripts/salvar-fixture-seatsaero.ts` |
| `seatsaero-real.headers.json` | headers da resposta acima | idem |

## Regra antes de commitar uma fixture nova

São respostas de busca pública, sem login — por isso podem ficar no repositório.
Confira antes de adicionar:

- nada de token, cookie, `Authorization` ou chave de API (os scripts salvam só os
  headers de **resposta**, nunca os de requisição);
- nada de dado de cliente (nome, CPF, e-mail, número de fidelidade, reserva).

Se a resposta trouxer qualquer um desses, ela não entra no git.
