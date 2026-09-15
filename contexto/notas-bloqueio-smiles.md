# Smiles: os dois bloqueios (406 e 403)

Última atualização: 2026-09-15.

A busca do Smiles sai de dentro do Chrome, com a página parada na origem da API
(`api-air-flightsearch-prd.smiles.com.br`). Existem dois jeitos diferentes de a
busca morrer, e eles não têm a mesma causa nem a mesma espera.

## 406 — orçamento de requisições por IP

- Quem responde é a API.
- Medido: o bloqueio dura mais de 20 min e replantar os cookies não recupera.
  É orçamento por IP numa janela móvel (as sondas gastaram ~99 e a seguinte
  bloqueou na 40ª).
- Não existe "tentar de novo": insistir só queima o que sobrou do saldo.
- No código: `ErroOrcamentoSmiles`.

## 403 — negado na borda (resolvido em 2026-09-15)

- Quem responde é o Akamai, com uma página HTML de `Access Denied` no lugar do
  JSON. O corpo traz um `Reference #…` — é o único pedaço útil pra suporte.
- **Causa: o header `channel: APP`.** Nada a ver com IP, cookie ou rota.
- No código: `ErroAcessoNegadoSmiles`, que continua valendo se voltar a
  acontecer por outro motivo.

### Como foi medido

Primeiro descartando o que parecia óbvio:

| teste | resultado |
|---|---|
| navegador → raiz e busca, nos 3 ambientes (prd/green/blue) | 403 HTML em todos |
| **fora do navegador** (`fetch` do Node, mesmo IP) | **406** — o IP está liberado |
| `www.smiles.com.br` no mesmo Chrome | 200 |
| limpar os 5 cookies do Akamai e repetir | 403 de novo |
| entrar pelo site primeiro, pro sensor validar o `_abck` | 403 de novo |

Com IP, cookie e rota descartados, sobrou o que a gente manda. Mesma URL,
mesmos cookies, uma chamada atrás da outra:

| headers | resultado |
|---|---|
| `x-api-key` + `channel: APP` | **403, HTML de bloqueio** |
| `x-api-key` sozinho | 200 · 8 voos · **calendário vazio** |
| `x-api-key` + `channel: WEB` | 200 · 40 voos · **6 dias de calendário** |

Ou seja: o 403 não é bloqueio no sentido de "espere passar". É uma regra nova
que recusa quem se diz app iOS vindo de um Chrome — contradição fácil de
detectar. E `WEB` não é só o que passa, é o único valor que traz o
`calendarDayList`, que é a base da varredura de 7 em 7 dias.

O `user-agent` falso de iOS saiu junto: `fetch` ignora esse header por
especificação, então ele nunca chegou a sair do bot.

### Três negativas que se parecem no log

| resposta | o que é |
|---|---|
| `406` JSON | orçamento de requisições por IP |
| `403` **HTML** `Access Denied` | a borda recusou esta requisição |
| `403` **JSON** `Missing Authentication Token` | resposta normal do API Gateway pra rota que não existe — é o que a raiz devolve sempre, não é bloqueio |

O número sozinho não diz nada; o corpo diz. `renovarSessaoSmiles()` guarda o
status da raiz ao abrir a sessão (`statusRaizAoAbrir`) e a mensagem do 403 usa
isso pra dizer se a origem inteira já vinha negada.

`npx tsx scripts/probe-smiles-bloqueio.ts` refaz essa medição em ~4
requisições: compara a chamada de fora do navegador com as variantes de header
e diz qual delas ainda passa.

## Um efeito colateral que já enganou o log

Antes desta correção o 403 caía no ramo genérico de status, virando "falha do
dia". Consequências, todas visíveis no log de 2026-09-15:

1. A varredura continuou depois do primeiro 403 e gastou mais requisições.
2. Como nenhum dia respondeu, `calendario` ficou vazio e a etapa 2 concluiu
   "esta rota não devolve calendário" e começou a preencher dia a dia — em cima
   de evidência falsa. **A rota tinha calendário; o que faltava era acesso.**
3. A página HTML de bloqueio entrava inteira em cada mensagem de erro.

Hoje o 403 para a varredura na hora, igual ao 406, e devolve o parcial com a
lacuna explicada.
