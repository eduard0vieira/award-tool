#!/bin/bash
# Closes the Chrome window the bot uses (the one `npm run chrome` opens) and,
# with it, the debugging port.
#
# Only touches the BOT PROFILE's process: your everyday Chrome, on the default
# profile, is left alone. The profile itself (cookies, AA and LATAM logins)
# stays on disk and is still valid the next time it opens.

PORT="${AA_CDP_PORT:-9222}"
BOT_PROFILE="${AA_CHROME_PROFILE:-$HOME/.chrome-bot-aa}"

if ! pgrep -f "user-data-dir=$BOT_PROFILE" > /dev/null; then
  echo "✅ A janela do bot já está fechada."
  exit 0
fi

# Ask politely first so Chrome saves the session and cookies properly (the
# LATAM login lives here).
pkill -f "user-data-dir=$BOT_PROFILE"

for _ in $(seq 1 20); do
  pgrep -f "user-data-dir=$BOT_PROFILE" > /dev/null || break
  sleep 0.5
done

if pgrep -f "user-data-dir=$BOT_PROFILE" > /dev/null; then
  echo "A janela não fechou sozinha; forçando..."
  pkill -9 -f "user-data-dir=$BOT_PROFILE"
  sleep 1
fi

if curl -s --max-time 2 "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
  echo "⚠️  A porta $PORT ainda responde — pode haver outro Chrome usando ela."
  exit 1
fi

echo "✅ Janela do bot fechada e porta $PORT liberada."
echo "   Os logins ficam salvos; é só rodar \`npm run chrome\` quando precisar de novo."
