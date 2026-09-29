#!/bin/bash
# Opens a Chrome window on the bot's profile, with the debugging port.
#
# The bot now opens its own window when searching, so this is no longer needed
# beforehand. And since the profile is exclusive, leaving this window open
# PREVENTS the bot from opening its own (searches fail until you run
# `npm run chrome:stop`). Attaching over the debugging port, the original plan,
# never completes on a real window on this machine (see the top of
# src/core/chrome-session.ts).
#
# Still useful for one thing: opening the bot's browser to browse or log in by
# hand with no search running. Close it before searching again.
#
# Two Chrome details shape this script:
#
# 1. --remote-debugging-port only applies when Chrome STARTS. With Chrome
#    already open, macOS hands the request to the running instance and the port
#    never comes up.
# 2. Since Chrome 136 the port is IGNORED on the default profile (their answer
#    to cookie theft attacks). Hence a separate profile, which also runs next to
#    your normal Chrome without closing anything.
#
# The profile is persistent: the history and cookies it builds stay for next
# time. If AA complains at first, browse aa.com a little in this window
# (searching any flight helps): it earns reputation and gets treated as normal browsing.

PORT="${AA_CDP_PORTA:-9222}"
PROFILE="${AA_CHROME_PERFIL:-$HOME/.chrome-bot-aa}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if curl -s --max-time 2 "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
  echo "✅ A janela do bot já está aberta (porta $PORT). Pode buscar na AA."
  exit 0
fi

if [ ! -x "$CHROME" ]; then
  echo "❌ Não achei o Google Chrome em $CHROME"
  exit 1
fi

mkdir -p "$PROFILE"
echo "Abrindo a janela do Chrome do bot (perfil: $PROFILE)..."
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "https://www.aa.com/" > /dev/null 2>&1 &

for _ in $(seq 1 30); do
  if curl -s --max-time 2 "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
    echo "✅ Pronto. Deixe essa janela aberta — é nela que o bot vai buscar."
    echo "   Seu Chrome normal continua funcionando do lado, sem interferência."
    exit 0
  fi
  sleep 0.5
done

echo "❌ A janela abriu, mas a porta $PORT não respondeu. Tente de novo."
exit 1
