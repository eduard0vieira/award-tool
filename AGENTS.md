# AGENTS.md

Regras permanentes para agentes trabalhando neste repositório.
Tarefas específicas vêm no chat. Isto aqui vale sempre.

Leia também o `contexto/CONTEXTO.md` — ele descreve a arquitetura, as fontes e o
estado real do sistema. Este documento cobre **como escrever código aqui**.

---

## O que é este projeto

Ferramenta interna de uma agência de viagens que trabalha com emissão por milhas.
Varre disponibilidade de passagens-prêmio em várias fontes e devolve as datas
disponíveis no formato usado para avisar o grupo de clientes.

Não é software genérico: o resultado vai direto para cliente pagante. **Um dado
errado num alerta custa credibilidade real com o cliente.** Prefira falhar visível
a entregar resultado plausível e errado.

---

## Princípio central: falha nunca se disfarça de resultado

Esta é a regra mais importante do repositório. A maior parte dos bugs históricos
deste projeto tem uma causa única: **dado ausente virou valor default e a falha
passou por resultado válido.**

Exemplos reais que já aconteceram:

- `_safe_int(default=4)` — assento inventado foi para o alerta do cliente
- `except: pass` num filtro de data — o filtro ficou desligado sem ninguém saber
- Campo `Direct` inexistente → default `False` → todos os voos descartados,
  sem erro
- `hasMore` não lido — primeira página tratada como resultado completo
- Status HTTP 400 significando duas coisas diferentes, tratado como uma só —
  "pedido recusado" saiu como "nenhuma disponibilidade"

Regras que derivam disso:

1. **Campo vindo de fonte externa não tem valor default.** Se o campo esperado
   não existe, isso é erro, com mensagem nomeando o campo e o contexto. Nunca
   substitua por palpite.
2. **Nenhum `catch` silencioso.** Todo catch captura erro específico, loga com
   contexto e propaga ou marca o resultado como parcial. `catch {}` e
   `catch (e) {}` vazios estão proibidos.
3. **Resultado incompleto se declara incompleto.** Se qualquer página, mês ou
   requisição falhou, o resultado carrega isso explicitamente e não vira alerta.
4. **Ausência de dado e falha na busca são estados diferentes.** "Não tem
   disponibilidade" nunca pode ser representado igual a "a busca quebrou".

Modele isso no tipo, não em convenção:

```ts
type ResultadoFonte =
  | { tipo: "ok"; secao: SecaoRelatorio }
  | { tipo: "sem_disponibilidade" }
  | { tipo: "parcial"; secao: SecaoRelatorio; motivo: string }
  | { tipo: "erro"; motivo: string; http?: number };
```

União discriminada em vez de `null`. O compilador obriga a tratar cada caso.

---

## Nunca programe contra schema imaginado

Toda integração com fonte externa começa por **salvar uma resposta real em disco**
e ler o que veio de verdade. Documentação e suposição não valem como base.

Uma implementação inteira deste projeto já foi escrita contra um schema imaginado,
com suíte de testes completa em cima das mesmas suposições. Todos os testes
passavam. O código estava errado. **Teste escrito contra a suposição do próprio
código não testa nada.**

Fixture vem de resposta real, sempre.

---

## Contratos que não se quebram

**Formato da string de datas.** `"Ago 2026: 07 (9), 25 (3)"` — mês abreviado em
português, dia com zero à esquerda, assentos entre parênteses. É contrato com o
`vcc-alertas-portal` e com o gerador de alertas. Não invente formato novo, não
altere `formatarListaPorMes`.

**Tipo comum de saída.** Toda fonte devolve `SecaoRelatorio` (`src/nucleo/comum.ts`). É o que
faz as fontes caberem no mesmo front e no mesmo gerador. Não crie tipo paralelo.

**Limitador de frequência entre requisições.** Existe porque as fontes pagas
limitam consulta e porque anti-bot detecta rajada. Não remova, não reduza sem
pedir.

---

## Segurança e dados

- Credenciais só em `.env`, nunca no código, nunca no commit. `.env.example` leva
  apenas o nome da chave.
- Nunca commite cookie, token, dado de cliente ou resposta de API contendo
  informação pessoal.
- Fixtures de teste vão anonimizadas.
- O servidor tem Basic Auth porque é exposto por túnel. Não remova nem enfraqueça.

---

## Convenções de código

- TypeScript + Node, rodando via `tsx` (sem etapa de build)
- Front é HTML + JS puro, sem framework e sem bundler. **Não introduza framework,
  bundler ou build step.**
- Nomes de identificadores e mensagens em português, seguindo o código existente
- Cada fonte vive em `src/fontes/<programa>/`, autocontida, seguindo o padrão das
  demais. `src/nucleo/` não importa fonte nenhuma
- Todo caminho de disco sai de `src/nucleo/caminhos.ts` — nunca calcule com
  `__dirname` no próprio arquivo
- Fontes com login usam o pool de sessões; fontes com API oficial não precisam de
  navegador nenhum

---

## Sempre pergunte antes de

- Instalar dependência nova (especialmente módulo nativo que exige compilação)
- Adicionar banco, fila externa, cache ou qualquer infraestrutura
- Refatorar código fora do escopo da tarefa atual
- Criar abstração nova ou camada de indireção
- Mexer numa fonte existente enquanto trabalha em outra
- Alterar `src/nucleo/comum.ts`, o formato de saída ou qualquer contrato acima

---

## Commits

**Um commit por mudança, mesmo pequena.** Nada de commit que junta conserto,
refatoração e documentação: se algo quebrar, o `git diff` precisa apontar uma
coisa só.

Mensagem no padrão Conventional Commits, uma linha, **sempre em inglês** — é a
única parte do repositório que não é em português (código, comentários e
interface continuam como estão).

```
<tipo>(<escopo opcional>): <descrição>
```

- Tipos válidos: `feat`, `fix`, `chore`, `refactor`, `docs`, `style`, `test`,
  `perf`, `ci`, `build`
- Tipo e escopo em minúsculas; descrição no imperativo, curta e sem ponto final
- Escopo é a fonte ou a área: `smiles`, `latam`, `aa`, `tap`, `seatspy`,
  `servidor`, `front`, `planilha`, `alertas`
- Sem emoji, sem corpo e sem trailer de atribuição (`Co-Authored-By` ou link de
  sessão). Os commits antigos com emoji ficam como estão; daqui pra frente, não

```
feat(latam): confirm miles with round-trip in a single search
fix(smiles): treat 406 as a block and return partial results
refactor: split sources into src/fontes
docs: record the azul recon
```

---

## Como trabalhar

Uma fase por vez. Ao fim de cada fase, pare, mostre o que mudou e o resultado do
critério de aceite. Não avance sem confirmação.

Se algo estiver ficando mais complexo do que parece razoável, **pare e diga por
quê** em vez de seguir. Complexidade inesperada normalmente significa que a
premissa está errada.
