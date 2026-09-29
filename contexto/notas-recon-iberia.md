# Recon Iberia (Fase 0) — anotações

> Levantado em 2026-08-18 com `npx tsx scripts/recon-iberia.ts GRU MAD`, num perfil
> de Chrome novo, sem login e sem cookie herdado.

## Resumo em uma linha

**A busca com Avios exige conta Iberia Club.** Clicar em Pesquisar com "Pagar com
Avios" marcado não chama disponibilidade nenhuma: pede login — em 2026-08 por
redirecionamento pro `login.iberia.com`, desde 2026-09 por um modal na própria
home (ver 4.1). Todo o resto do caminho está limpo — é só isso que falta.

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

## 4.1. Mudança de comportamento (2026-09-22)

A busca com Avios **não redireciona mais** pro `login.iberia.com`: ela abre um
**modal na própria home** ("Acesso a Iberia Club"), sem trocar de URL. Uma
execução inteira morreu por causa disso — o recon reconhecia login só pela URL,
concluiu que ninguém tinha pedido nada e desistiu em 25s, com o modal na tela.

O que continua valendo: nenhuma chamada de disponibilidade sai antes do login, e
nenhum desafio de anti-bot apareceu (token anônimo segue voltando 200).

Hoje o script reconhece os dois caminhos — URL, iframe de login e modal — e diz
no log por qual reconheceu. Quando não reconhece, despeja o diagnóstico (frames,
campos da caixa de login) e salva o HTML em `fixtures/iberia-login-modal.html`.

## 5. Como fazer o login (fluxo pronto)

```
npm run recon:iberia GRU MAD 2026-11-16
```

O script preenche a busca e, quando a Iberia pedir login, tenta entrar sozinho com
o que está no `.env` (abaixo). Sem credencial lá, ele **para e espera você**: traz
a janela do Chrome do bot pra frente, avisa no terminal, e fica checando a cada 3
segundos. Nos dois casos, assim que a sessão abrir o recon continua — se a Iberia
não refizer a busca, ele repete o formulário com a sessão já válida.

- espera padrão: 10 min (`IBERIA_LOGIN_WAIT_MS` muda isso);
- o login fica salvo no perfil do Chrome do bot (`~/.chrome-bot-aa`), então é
  **uma vez só**, não a cada busca;
### Preenchimento automático (opcional)

Com `IBERIA_EMAIL` e `IBERIA_PASSWORD` no `.env`, o script preenche **e envia** o
formulário — inclusive o fluxo de duas etapas, em que a senha só aparece depois
do e-mail. A busca roda sem ninguém na frente da máquina, que era o objetivo.

A janela do bot continua abrindo: se a Iberia pedir 2FA ou captcha, é ali que
você conclui. As credenciais moram só no `.env` (que está no `.gitignore`), nunca
no código e nunca no log.

```
# no .env do projeto (já está no .gitignore)
IBERIA_EMAIL=...
IBERIA_PASSWORD=...
```

Sem essas variáveis, o login é todo na mão — o script só espera.

Seletores do login (Salesforce Identity), caso mudem:
`input[name="loginPage:theForm:loginEmailInput"]`, `input[type=password]`,
`input[name="loginPage:theForm:loginSubmit"]`.

Se aparecer o erro de perfil em uso, feche o Chrome do bot com `npm run
chrome:parar` (ou pare o `npm run server`, que também segura o perfil) e rode de
novo.

## 6. O que falta, e de quem depende

Com uma sessão logada da Iberia Club, o caminho daqui é o mesmo que funcionou na
Azul: deixar o site fazer a requisição e trocar o corpo. Mas o login é do dono da
conta — **não é coisa que o bot faça sozinho**, e a senha não passa por aqui.

Enquanto isso não existir, ficam sem resposta:

1. qual endpoint traz a disponibilidade em Avios (candidato do projeto antigo:
   `api/sse-rpa/rs/v1/availability`, no mesmo host que o site já usa);
2. quantos dias vêm por resposta — o número que decide o custo de um ano;
3. se há calendário de preços (como na LATAM em dinheiro) ou só dia a dia;
4. se a sessão logada cai sozinha, e com que frequência.

## 7. Fase 1 concluída (2026-09-22) — o que a resposta real diz

Login automático pelo `.env` funcionou, e desta vez a Iberia **redirecionou**
(não foi modal): os dois caminhos existem, então o script precisa dos dois.

**Endpoint confirmado** — é o mesmo que o projeto antigo usava:

```
POST https://ibisservices.iberia.com/api/sse-rpa/rs/v1/availability   → 200
{"isPetFlight":false,
 "slices":[{"origin":"GRU","destination":"MAD","date":"2026-12-15"}],
 "passengers":[{"passengerType":"ADULT","count":"1"}],
 "marketCode":"BR","preferredCabin":""}
```

Headers que a aplicação manda: `authorization` (JWT emitido após o login),
`x-request-appversion`, `x-request-device`, `x-request-osversion`,
`x-observations-current-page: availability`.

**Uma data por resposta.** Cada chamada devolve um `originDestination` com 5–6
`slices` (as opções de voo daquele dia), 26–32 `offers` no total. Varrer um ano
é uma requisição por dia — a menos que o calendário (abaixo) funcione.

**A sessão aguenta.** Repetir a mesma chamada de dentro da página com +1 e +30
dias voltou 200 nas duas (`fixtures/iberia-real-mais1.json`,
`iberia-real-mais30.json`). Confirma o padrão da AA/Azul: quem assina o TLS e
manda o cookie é o navegador.

### O bloqueio novo: a disponibilidade não traz preço

```json
{"offerId":"AT021420261215E","bookingClass":"ECONOMY","bookingCode":"E",
 "fareFamily":"X","rbd":"E","remainingSeats":4,"fareBasis":"EATFF"}
```

Varredura no arquivo inteiro: **nenhum campo de valor, Avios, taxa ou moeda.**
O `models.py` do projeto antigo lia `offer.totalPrice.fare` — campo que não
existe nesta resposta. Mais um caso de schema imaginado, agora medido.

Isso importa porque `DiaFormatado.valorK` é `number` obrigatório em
`src/nucleo/comum.ts`: **sem valor por dia não há `SecaoRelatorio` legal**, e
inventar um placeholder é exatamente a falha que este repositório proíbe.

Duas pistas de onde o número pode estar, nenhuma verificada:

- o corpo enviado **não tem marca de Avios** (nada de `pagoAvios`), embora a URL
  da página tenha `pagoAvios=true` — o contexto de resgate pode viajar no bearer;
- `POST /api/sse-rpa/rs/v1/calendar` existe e voltou **404 com `marketCode: BR`**;
  nunca foi repetido com outro mercado.

### Armadilha do próprio recon (corrigida)

A resposta era pareada ao pedido **pela URL**, e a página chama
`/availability` duas vezes (marketCode BR e depois US). Isso pode ter grudado a
resposta de um pedido no outro: `iberia-real.json` diz
`contextMetadata.country: "US"` com `marketCode: "BR"` no corpo. **Trate esse
arquivo como suspeito**; os dois de replay (`+1`/`+30`) vêm de chamadas isoladas
e são confiáveis. O pareamento agora é pela identidade da requisição.

## 8. A rodada que buscou o aeroporto errado (2026-09-22)

Uma execução inteira se perdeu e **quase passou por resultado válido**: o
autocomplete do destino escolheu **Madison (MSN)** em vez de Madrid (MAD), e a
tela respondeu "não encontramos assentos Iberia Club exclusivos" — que é a
resposta certa para a pergunta errada.

Causa: digitar `MAD` lista Madrid **e** Madison, e o script fazia
`ArrowDown + Enter` às cegas, pegando o primeiro da lista. Agora a opção é
escolhida pelo código (`\bMAD\b`, que rejeita "Madison (MSN)"), e — o que
realmente importa — **a URL do resultado é conferida** contra o que foi pedido
(`BEGIN_CITY_01` / `END_CITY_01`). Divergiu, o script descarta e diz por quê.

Três coisas úteis vieram dela assim mesmo:

1. **`204` é "sem disponibilidade", e não erro.** A chamada de disponibilidade
   com `marketCode: US` voltou 204 com corpo vazio. Ausência de dado e falha na
   busca são estados diferentes — o bot vai precisar dessa distinção.
2. **O `/calendar` volta 404 nos dois mercados** (BR e US). *(Duas correções:
   o 404 é semântico, ver seção 9; e a rota certa é `/calendar/grid`, ver
   seção 10 — é ela que traz o preço e a faixa de datas.)*
3. **O fluxo É de resgate.** A mensagem fala em "assentos Iberia Club
   exclusivos" — então a `/availability` que voltou 200 na rodada anterior é
   disponibilidade de prêmio mesmo, e continua sem trazer preço.

## 9. Rodada limpa (2026-09-22) — o que fechou e o que não

Destino conferido pela URL (`END_CITY_01=MAD`), login automático, três respostas
de disponibilidade pareadas corretamente.

**O preço não está na disponibilidade — confirmado em três respostas.** Todas as
ofertas têm exatamente estes campos:

```
offerId, bookingClass, bookingCode, fareFamily, rbd, remainingSeats, fareBasis
```

Nenhum campo de valor, Avios, taxa ou moeda em nenhum nível do JSON.

**O contexto de resgate não viaja no bearer.** As claims do token da chamada de
disponibilidade são de sessão web comum:

```
azp = iberia_web | scope = profile email | typ = Bearer
exp, iat, jti, iss, sub, sid, acr, realm_access, email_verified, preferred_username
```

Nada de Avios, redemption ou loyalty. A hipótese de que o resgate ia no token
está descartada.

**O 404 do calendário é semântico, não de rota.** O corpo diz:

```json
{"errors":[{"code":"SSE_RPA_10402",
            "reason":"Disponibilidade não encontrada para a pesquisa selecionada."}]}
```

Testado com `marketCode` BR, US, ES e GB — os quatro iguais. *(Resolvido na
seção 10: insistir valeu, mas o caminho era outra rota — `/calendar/grid`.)*

### Onde procurar o número de Avios (próxima rodada)

O filtro de captura só olhava `ibisservices` e `ibisauth`. Se o preço vier de
outra rota da casa, ele estava invisível — o filtro agora pega qualquer host
`*.iberia.com`, menos estático e rastreador. Junto disso, o recon passa a
imprimir **os valores em Avios renderizados na tela**: se a página mostra o
número e nenhuma resposta capturada o contém, a conta é feita no cliente (a
Iberia resgata por tabela de distância), e aí a fonte precisa de outro caminho.

## 10. O achado que muda o desenho: `/calendar/grid` (2026-09-22)

O link **"Vista mensal de voos"**, na tela de seleção, dispara:

```
POST https://ibisservices.iberia.com/api/sse-rpa/rs/v1/calendar/grid   → 200
```

A resposta (`fixtures/iberia-mensal-0.json`, 8 KB) traz **191 dias numa única
chamada** — de 2026-09-22 a 2027-03-31, seis meses — no formato:

```json
{"contextMetadata":{"language":"pt","country":"US"},
 "outbound":{"slice":{"origin":"GRU","destination":"MAD"},
             "availabilityCalendar":[
               {"date":"2026-09-22","lock":false},
               {"date":"2026-10-18","avios":28150,"lock":false},
               {"date":"2026-10-26","avios":18000,"lock":false}]}}
```

**93 dos 191 dias trazem `avios`** (18.000 a 50.500 nesta busca). O campo
simplesmente não existe nos dias sem disponibilidade — o que casa com a regra da
casa: ausência de dado é ausência, não zero.

### Por que isso resolve dois problemas de uma vez

**O preço apareceu.** A `/availability` não tem preço nenhum e a tela dela
também não (só o saldo "0 Avios" do cabeçalho). O número de Avios mora aqui.

**O custo caiu de ordem de grandeza.** A leitura anterior — "uma requisição por
dia, 359 por ano" — está **errada**. São ~2 chamadas para cobrir um ano.

### Desenho que isso sugere para a fonte

O mesmo formato de duas camadas que a AA já usa neste repositório:

1. `/calendar/grid` — que dias têm prêmio e por quantos Avios (1 chamada por
   ~6 meses). Dá `data` + `valorK`.
2. `/availability` — só nos dias que interessam, pra `remainingSeats` por voo.

Falta confirmar, antes de escrever a fonte: o **corpo** da requisição do
`/calendar/grid` (o passo 8 do recon imprimia só URL e tamanho — corrigido), se
ele aceita janela maior que 6 meses, e se `lock: true` significa data bloqueada.

## 11. A busca parou de responder depois de muitas rodadas (2026-09-22)

Depois de ~9 execuções do recon em cerca de 90 minutos, a busca passou a cair em:

```
URL: ...#!/ibbkerror
"Lamentamos, não podemos mostrar os voos. Por motivos alheios à Iberia,
 é impossível mostrar a disponibilidade de voos neste momento"
```

As quatro chamadas da busca (`/availability` e `/calendar`, nos dois mercados)
ficaram com **status ausente e 0 bytes** — nenhuma resposta chegou, não é erro
HTTP com corpo. Antes disso, as mesmas chamadas vinham 200 com 27 KB.

**Duas explicações cabem no que foi observado, e elas não foram separadas:**
corte por frequência (a mais provável, dado o ritmo) ou sessão em estado ruim
depois de dois logins em poucos minutos — consequência do falso positivo do
detector de modal, que mandou o script logar de novo sem necessidade.

O que **não** é: anti-bot no sentido do `cheap-flights`. Nenhum desafio, nenhum
403 — em nenhuma das rodadas do dia.

Para decidir entre as duas: esperar 30+ minutos e rodar **uma** vez. Se voltar
limpo, é frequência, e aí o intervalo do `LimitadorFrequencia` precisa ser
medido antes de escrever a fonte.

Independente da causa, uma coisa está estabelecida e vale para o desenho:

- **`status` ausente com 0 byte é um terceiro estado**, diferente de 200 (tem
  disponibilidade) e de 204 (não tem). Tratar isso como "sem disponibilidade"
  mandaria "não achei nada" pro cliente quando a busca nem saiu — é o mesmo erro
  do HTTP 400 com dois significados que o AGENTS.md lista. O `ResultadoFonte` da
  fonte precisa carregar esse caso.

## 12. Procedência dos fixtures (importante)

- `iberia-mensal-0.json` — **confiável**. Veio de rodada limpa; é o achado
  principal (seção 10).
- `iberia-real-mais1.json`, `iberia-real-mais30.json` — **confiáveis**. Vêm do
  replay, que dispara uma chamada isolada por vez.
- `iberia-real.json` — **usar com cuidado**. Foi sobrescrito várias vezes ao
  longo do dia; a versão em disco (27688 bytes) veio da rodada que se perdeu
  indo pro home dos EUA depois do falso positivo do modal. O formato confere com
  os outros dois, mas se algum detalhe importar, regrave.

## 13. Fase 2: a fonte funciona (2026-09-22)

`src/fontes/iberia/bot-iberia.ts` + `scripts/buscar-iberia.ts`
(`npm run iberia GRU MAD 40000`). Varredura real de um ano:

```
Calendário a partir de 2026-09-23:  42 dias, até 2026-12-31
Calendário a partir de 2027-01-01: 120 dias, até 2027-04-30
Calendário a partir de 2027-05-01: 189 dias, até 2027-08-31
Calendário a partir de 2027-09-01:  99 dias, até 2027-09-30

Janela 2026-09-23 → 2027-09-30 · 248 dias com prêmio · 18K a 50,5K Avios
```

**A janela se move com o `date` do corpo** — pergunta que estava aberta. Um ano
sai em **4 chamadas**, não 359.

### Três coisas que só apareceram ao rodar de verdade

1. **401 sem o bearer.** O `ibisservices` exige `authorization: Bearer`, que o
   SPA guarda em memória (não é cookie) — então `fetch` de dentro da página não
   o herda. A fonte escuta as requisições que a própria página faz e reusa o
   token de lá. Sem token, erro nomeado em vez de busca vazia.
2. **`ERR_ABORTED` no `goto` é normal.** O site reescreve a URL durante a
   navegação; quem decide se deu certo é a URL final, não o retorno do `goto`.
3. **A rota por hash demora a assentar.** Checar uma vez 8s depois do load pega
   estado intermediário; a fonte espera a URL virar `#!/availability` ou
   `#!/ibbkerror` antes de julgar.

E o `#!/ibbkerror` de mais cedo era **transitório**: passada a pausa, a mesma
URL que a fonte monta chegou aos resultados igual à que o site monta (testado
lado a lado em `scripts/testar-url-iberia.ts`).

### `lock: true` — o que se sabe

Apareceu em 13 dias da varredura de um ano. **Nenhum deles tinha `avios`.** A
fonte descarta dia travado e só declara o resultado parcial quando o dia
descartado TINHA preço — dia travado sem prêmio não é perda e não vira ruído.

### O que esta fonte ainda não faz

**Não separa cabine.** A grade tem `preferredCabin: ""` e devolve um número por
dia — o mais barato, sem dizer de qual cabine. A AA busca por cabine e sabe o
que está olhando; aqui não. Separar exige a segunda camada (`/availability`,
que traz `bookingClass` por oferta) e uma decisão de produto.

**Não traz vagas**, pelo motivo documentado no fim do `bot-iberia.ts`: preço e
assento vêm de chamadas diferentes e não há como ligar um ao outro pelo dado.

**Não está no servidor nem no front** — roda pelo script. Integrar é a Fase 2b.

## 14. Camada de voos: o que trava (2026-09-23)

A segunda camada (`/availability`, uma requisição por data) está escrita e
tipada, mas **não roda de ponta a ponta**. Vem desligada (`--dias=0`).

O que foi medido, em ordem:

1. **`fetch` da aba, aba na busca** → funciona (foi assim no recon).
2. **`fetch` da aba, aba derivada pro login** → `TypeError: Failed to fetch`.
   Não é bloqueio: é cross-origin, porque a aba não está mais no
   `www.iberia.com`.
3. **`context.request` do Playwright** (não depende da aba) → **401**, com o
   MESMO bearer e os MESMOS headers que o `/calendar/grid` aceita. Alguma coisa
   da sessão só existe no contexto da aba.
4. **Headers reais copiados do site** (`x-request-appversion`,
   `x-request-device`, `x-observations-*`) → não mudou o 401 do item 3.

E a causa de fundo: **a sessão da Iberia cai em poucos minutos**. O calendário
(4 chamadas, ~1 min) termina bem; quando o detalhe começa, a aba já foi mandada
pro `login.iberia.com` — e reabrir a busca volta pro login. Logar de novo pelo
`.env` (implementado em `fazerLogin`) não resolveu: a aba é mandada pro login
de novo logo depois.

Caminhos ainda não tentados, para quem pegar isso:

- fazer o detalhe **junto** do calendário, na mesma janela de sessão saudável,
  em vez de depois;
- descobrir por que o `context.request` toma 401 — comparar byte a byte os
  headers reais (incluindo `origin`/`referer`) com os que ele manda;
- aceitar uma vez a tela `RemoteAccessAuthorizationPage` do Salesforce na mão e
  ver se a queda de sessão para.

## 15. `preferredCabin` é ignorado pelo calendário (2026-09-23)

Medido com `scripts/probe-cabine-iberia.ts`: mesma rota, mesma data, mesmo
token, só mudando o campo do corpo.

```
preferredCabin=(vazio):   100 dias, 42 com preço, 18000 a 35100 Avios
preferredCabin=BUSINESS:  100 dias, 42 com preço, 18000 a 35100 Avios
preferredCabin=ECONOMY:   idem   | TOURIST: idem | PREMIUMTOURIST: idem | FIRST: idem
```

Resposta **idêntica** nas seis. O `/calendar/grid` não sabe responder por
cabine — o valor é sempre o mais barato do dia, seja qual for a classe.

Consequência para o produto, e ela é séria: **não existe "datas de executiva"
com preço de executiva nesta fonte.** O seletor de cabine do front só filtra a
planilha de voos (via `bookingClass` das ofertas do `/availability`). Por isso
o job agora devolve um aviso explícito junto do resultado quando uma cabine é
escolhida — número de econômica anunciado como executiva é erro que chega no
cliente.

Caminho possível, não explorado: descobrir se um dia tem prêmio em executiva
exige o `/availability` daquele dia (~15s cada). Serve para uma lista curta de
datas, não para varrer um ano.

## 16. Detalhe em escala: a Iberia corta por volta de 40–60 consultas (2026-09-28)

Tentativa de voltar ao ritmo do `cheap-flights` (lotes de 30 a cada 7s no
`/availability`), agora de dentro da aba — que é o que passa pelo anti-bot.
Medido com `scripts/medir-lotes-iberia.ts`, GRU→MAD, ~247 datas, sessão
logada, logo depois do calendário, com 10–20 min de pausa entre as rodadas:

```
30 em paralelo:            todas "Failed to fetch" em 1,2s (depois de 15 ok)
lotes de 10, 7s de pausa:  1º lote 10/10; 2º lote 6/10
lotes de 5, 8s entre eles: tela ibbkerror no dia ~30; corte definitivo no ~40
1 por vez, a cada 3s:      corte definitivo no dia 59 (8,3 min), 9 repetições antes
```

O corte aparece como `TypeError: Failed to fetch` com a aba ainda em
`www.iberia.com/flights/` — não é a sessão caindo, é o site recusando. Reabrir
a busca nessa hora cai na tela de erro "não podemos mostrar os voos".

Leitura: **o ritmo muda pouco o total.** Rajada é cortada logo; espaçar leva o
corte de ~40 pra ~60 consultas, não pra 247. Parece cota por janela de tempo
(ou por sessão), não limite de velocidade. Não medido: se um login novo zera a
cota, e quanto tempo de pausa a devolve.

Consequência: "todas as datas detalhadas" do bot antigo não cabe numa rodada
só. O detalhe ficou sequencial (`IBERIA_DETAIL_BATCH`, padrão 1), que é mais
leve que o carregamento de página por dia que ele substituiu.
