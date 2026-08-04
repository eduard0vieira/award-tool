#!/bin/bash
# Abre o Chrome com a porta de depuração ligada, pro bot poder buscar na AA
# numa aba do seu navegador de sempre (ver iniciarSessaoAA em bot-aa.ts).
#
# Pega pulo do gato: a flag só vale quando o Chrome INICIA. Se ele já estiver
# aberto, o macOS entrega o pedido pra instância existente e a porta nunca
# abre — por isso aqui a gente fecha o Chrome antes (ele restaura as abas ao
# voltar) em vez de deixar o comando falhar silenciosamente.

PORTA="${AA_CDP_PORTA:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if curl -s --max-time 2 "http://localhost:$PORTA/json/version" > /dev/null 2>&1; then
  echo "✅ Chrome já está aberto com a porta $PORTA. Pode usar o bot."
  exit 0
fi

if [ ! -x "$CHROME" ]; then
  echo "❌ Não achei o Google Chrome em $CHROME"
  exit 1
fi

if pgrep -x "Google Chrome" > /dev/null; then
  echo "O Chrome está aberto sem a porta de depuração — precisa reiniciar ele."
  echo "Suas abas são restauradas quando ele voltar."
  read -r -p "Fechar e reabrir o Chrome agora? [s/N] " resposta
  case "$resposta" in
    s|S|sim|SIM) ;;
    *) echo "Cancelado. Feche o Chrome manualmente (Cmd+Q) e rode de novo."; exit 1 ;;
  esac

  osascript -e 'quit app "Google Chrome"' > /dev/null 2>&1
  for _ in $(seq 1 20); do
    pgrep -x "Google Chrome" > /dev/null || break
    sleep 0.5
  done
  if pgrep -x "Google Chrome" > /dev/null; then
    echo "❌ O Chrome não fechou (alguma janela pedindo confirmação?). Feche com Cmd+Q e rode de novo."
    exit 1
  fi
fi

echo "Abrindo o Chrome com a porta $PORTA..."
"$CHROME" --remote-debugging-port="$PORTA" > /dev/null 2>&1 &

for _ in $(seq 1 20); do
  if curl -s --max-time 2 "http://localhost:$PORTA/json/version" > /dev/null 2>&1; then
    echo "✅ Pronto. O bot já pode buscar na AA usando este Chrome."
    exit 0
  fi
  sleep 0.5
done

echo "❌ O Chrome abriu, mas a porta $PORTA não respondeu. Tente de novo."
exit 1
