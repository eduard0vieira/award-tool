#!/bin/bash
# Abre uma janela do Chrome no perfil do bot, com a porta de depuração.
#
# ATENÇÃO: hoje o bot abre a janela dele sozinho ao buscar — não é mais preciso
# rodar isso antes. E como o perfil é de uso exclusivo, deixar esta janela
# aberta IMPEDE o bot de abrir a dele (a busca falha até você rodar
# `npm run chrome:parar`). O attach por porta de depuração, que era o plano
# original, não conclui numa janela real nesta máquina — ver o comentário do
# topo de src/nucleo/sessao-chrome.ts.
#
# Continua útil pra uma coisa: abrir o navegador do bot pra você navegar/logar
# à mão sem nenhuma busca rodando. Feche antes de voltar a buscar.
#
# Dois detalhes do Chrome que ditam o formato disso aqui:
#
# 1. A flag --remote-debugging-port só vale quando o Chrome INICIA. Com ele
#    já aberto, o macOS entrega o pedido pra instância existente e a porta
#    nunca sobe.
# 2. Desde o Chrome 136 a porta é IGNORADA quando o perfil é o padrão (foi a
#    resposta deles a ataques de roubo de cookie). Por isso aqui usamos um
#    perfil separado — que, de quebra, roda ao lado do seu Chrome normal, sem
#    precisar fechar nada.
#
# Esse perfil é persistente: o histórico/cookies que ele acumular ficam pra
# próxima. Se a AA reclamar nas primeiras vezes, navegue um pouco em aa.com
# nessa janela (buscar um voo qualquer já ajuda) — ela ganha reputação e
# passa a ser tratada como navegação normal.

PORTA="${AA_CDP_PORTA:-9222}"
PERFIL="${AA_CHROME_PERFIL:-$HOME/.chrome-bot-aa}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if curl -s --max-time 2 "http://localhost:$PORTA/json/version" > /dev/null 2>&1; then
  echo "✅ A janela do bot já está aberta (porta $PORTA). Pode buscar na AA."
  exit 0
fi

if [ ! -x "$CHROME" ]; then
  echo "❌ Não achei o Google Chrome em $CHROME"
  exit 1
fi

mkdir -p "$PERFIL"
echo "Abrindo a janela do Chrome do bot (perfil: $PERFIL)..."
"$CHROME" \
  --remote-debugging-port="$PORTA" \
  --user-data-dir="$PERFIL" \
  --no-first-run \
  --no-default-browser-check \
  "https://www.aa.com/" > /dev/null 2>&1 &

for _ in $(seq 1 30); do
  if curl -s --max-time 2 "http://localhost:$PORTA/json/version" > /dev/null 2>&1; then
    echo "✅ Pronto. Deixe essa janela aberta — é nela que o bot vai buscar."
    echo "   Seu Chrome normal continua funcionando do lado, sem interferência."
    exit 0
  fi
  sleep 0.5
done

echo "❌ A janela abriu, mas a porta $PORTA não respondeu. Tente de novo."
exit 1
