#!/bin/bash
# Fecha a janela do Chrome que o bot usa (a que `npm run chrome` abre) e,
# com ela, a porta de depuração.
#
# Só mexe no processo do PERFIL DO BOT — o seu Chrome de todo dia, que roda
# no perfil padrão, não é tocado.
#
# O perfil em si (cookies, logins da AA e da LATAM) fica no disco e continua
# valendo na próxima vez que você abrir.

PORTA="${AA_CDP_PORTA:-9222}"
PERFIL_BOT="${AA_CHROME_PERFIL:-$HOME/.chrome-bot-aa}"

if ! pgrep -f "user-data-dir=$PERFIL_BOT" > /dev/null; then
  echo "✅ A janela do bot já está fechada."
  exit 0
fi

# Primeiro pede pra fechar com educação, pra o Chrome salvar a sessão e os
# cookies direitinho (importante: é o login da LATAM que mora aqui).
pkill -f "user-data-dir=$PERFIL_BOT"

for _ in $(seq 1 20); do
  pgrep -f "user-data-dir=$PERFIL_BOT" > /dev/null || break
  sleep 0.5
done

if pgrep -f "user-data-dir=$PERFIL_BOT" > /dev/null; then
  echo "A janela não fechou sozinha; forçando..."
  pkill -9 -f "user-data-dir=$PERFIL_BOT"
  sleep 1
fi

if curl -s --max-time 2 "http://localhost:$PORTA/json/version" > /dev/null 2>&1; then
  echo "⚠️  A porta $PORTA ainda responde — pode haver outro Chrome usando ela."
  exit 1
fi

echo "✅ Janela do bot fechada e porta $PORTA liberada."
echo "   Os logins ficam salvos; é só rodar \`npm run chrome\` quando precisar de novo."
