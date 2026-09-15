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

## 403 — negado na borda

- Quem responde é o Akamai, com uma página HTML de `Access Denied` no lugar do
  JSON. O corpo traz um `Reference #…` — é o único pedaço útil pra suporte.
- Apareceu em 2026-09-15, numa varredura que até então dava 406.
- **Não há duração medida.** A mensagem do bot não promete tempo de espera de
  propósito; o número do 406 não vale aqui.
- No código: `ErroAcessoNegadoSmiles`.

## O discriminador que falta medir

Se o 403 é do IP inteiro ou só do caminho de busca, dá pra separar assim: a raiz
da API (`GET /`) responde **406** quando está tudo normal. Se ela passar a
responder **403**, a borda está negando a origem inteira — bloqueio de IP. Se a
raiz continuar 406 e só `/v1/airlines/search` der 403, o bloqueio é do padrão da
chamada, e trocar de IP pode não resolver.

`renovarSessaoSmiles()` guarda esse status ao abrir a sessão (`statusRaizAoAbrir`)
e a mensagem do 403 diz quando a raiz já vinha negada. Falta rodar com a raiz
403 pelo menos uma vez pra confirmar a leitura.

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
