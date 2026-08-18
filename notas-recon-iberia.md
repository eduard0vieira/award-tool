# Recon Iberia (Fase 0) — anotações

> Levantado em 2026-08-18 com `npx tsx scripts/recon-iberia.ts GRU MAD`, num perfil
> de Chrome novo, sem login e sem cookie herdado.

## Resumo em uma linha

**A busca com Avios exige conta Iberia Club.** Clicar em Pesquisar com "Pagar com
Avios" marcado não chama disponibilidade nenhuma: manda direto pro
`login.iberia.com`. Todo o resto do caminho está limpo — é só isso que falta.

## 1. O bloqueio do projeto antigo não é o nosso

O `cheap-flights` atacava a API do app iOS e morreu por causa de Akamai: cookies
`_abck`/`bm_sz` colados à mão e um `X-acf-sensor-data` que só o app nativo sabe
assinar. Nada disso nos atinge, porque quem monta a requisição é o site.

Dois sinais confirmam:

```
POST https://ibisauth.iberia.com/api/auth/realms/commercial_platform
     /protocol/openid-connect/token          → 200, grant_type=client_credentials
GET  https://ibisservices.iberia.com/api/rdu-loc/rs/loc/v1/location/areas/origin/
```

- O **mesmo endpoint de token** que o projeto antigo chamava com cookie colado, a
  home chama sozinha, anônima, e recebe 200.
- O site usa o **mesmo host `ibisservices.iberia.com`** da API do app. O mapa de
  endpoints levantado lá provavelmente continua valendo.

Nenhum desafio de anti-bot apareceu em nenhuma das execuções.

## 2. Onde para: login

Formulário preenchido (GRU→MAD, data, 1 adulto), `paywithAvios` marcado, clique em
`#buttonSubmit1`:

```
URL final: https://login.iberia.com/IDY_LoginPage?...&market=BRpt&startURL=...
Título:    Iberia Login
Texto:     "Faça o login … E-mail ou Num. Iberia Club … Senha"
```

**Nenhuma chamada de disponibilidade acontece antes disso.** O redirecionamento vem
do próprio handler do Avios.

Controle rodado (`SEM_AVIOS=true`): sem marcar Avios a busca não sai da home — mas
isso é **inconclusivo**, porque provavelmente esbarra na validação do calendário
(ver seção 4), não no login. Ou seja: sei que Avios exige login; **não** sei ainda
como se comporta a busca em dinheiro.

## 3. O aviso de cookies bloqueia tudo — e não tem botão de recusar

Foi o que travou as primeiras tentativas, e o sintoma engana: cliques dando timeout
em campos visíveis, e cliques forçados que não surtem efeito.

```js
document.elementFromPoint(630, 232)
// → div.onetrust-pc-dark-filter.ot-fade-in
```

O banner cobre a página inteira com um filtro que intercepta todo clique. E os
únicos botões são **"Aceitar todos os cookies"** e **"Definições de cookies"** —
não existe "Rejeitar todos", apesar de o texto do banner citar um.

O script **não aceita nada**: remove a cobertura e segue. O banner fica sem
resposta, que é o mais próximo de "não consenti" que dá pra fazer sem clicar em
aceitar.

## 4. Detalhes do formulário (pra quem for mexer)

| o que | como |
|---|---|
| origem / destino | `#flight_origin1` / `#flight_destiny1`, autocomplete: digitar, ↓, Enter |
| trecho | `#ticketops-seeker` — `Ida e volta`, `Só ida`, `Stopover`, `Múltiplos trajetos` |
| Avios | `#paywithAvios` — o clique direto não pega; só `checked = true` + eventos |
| datas | `#flight_round_date1` / `#flight_return_date1`, formato DD/MM/YYYY |
| cabine | `#tarifa1` — `R` (mais económica), `N` (premium economy), `B` (business) |
| buscar | `#buttonSubmit1` (o botão visível é uma lupa; o texto "Pesquisar" é interno) |

Duas armadilhas: **o perfil guarda o estado do formulário entre execuções** (o
controle sem Avios rodou com Avios ligado na primeira tentativa e mentiu), e
**escrever no campo de data não basta** — o valor aparece, mas o calendário mantém
o estado dele por dentro.

## 5. O que falta, e de quem depende

Com uma sessão logada da Iberia Club, o caminho daqui é o mesmo que funcionou na
Azul: deixar o site fazer a requisição e trocar o corpo. Mas o login é do dono da
conta — **não é coisa que o bot faça sozinho**, e a senha não passa por aqui.

Enquanto isso não existir, ficam sem resposta:

1. qual endpoint traz a disponibilidade em Avios (candidato do projeto antigo:
   `api/sse-rpa/rs/v1/availability`, no mesmo host que o site já usa);
2. quantos dias vêm por resposta — o número que decide o custo de um ano;
3. se há calendário de preços (como na LATAM em dinheiro) ou só dia a dia;
4. se a sessão logada cai sozinha, e com que frequência.
