#!/bin/bash
# Copies ONLY one domain's cookies from your normal Chrome into the bot's
# profile. Usage:
#
#   bash scripts/import-cookies.sh aa.com
#   bash scripts/import-cookies.sh latamairlines.com
#
# What it is for:
# - aa.com: Akamai answers "Access Denied" to any browser arriving without its
#   cookies, even a plain Chrome with a new profile and no automation. Bringing
#   your everyday browser's cookies fixes it.
# - latamairlines.com: the miles search requires a logged-in account. With the
#   session cookies, the bot inherits YOUR login without any password stored anywhere.
#
# Only the requested domain is copied; other sites' cookies never leave your
# browser. The bot profile's existing cookies (other domains) are kept, so
# importing aa.com and latamairlines.com never erases one another. Values stay
# encrypted by Chrome, which decrypts them through your user's keychain.

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Uso: bash scripts/import-cookies.sh <dominio>"
  echo "Ex.: bash scripts/import-cookies.sh latamairlines.com"
  exit 1
fi

BOT_PROFILE="${AA_CHROME_PERFIL:-$HOME/.chrome-bot-aa}"
SOURCE="$HOME/Library/Application Support/Google/Chrome/Default/Cookies"
TARGET="$BOT_PROFILE/Default/Cookies"

if [ ! -f "$SOURCE" ]; then
  echo "❌ Não achei os cookies do seu Chrome em:"
  echo "   $SOURCE"
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  echo "❌ O perfil do bot ainda não existe. Rode \`npm run chrome\` uma vez antes."
  exit 1
fi

if pgrep -f "user-data-dir=$BOT_PROFILE" > /dev/null; then
  echo "❌ A janela do bot está aberta — feche ela antes (o Chrome tranca o arquivo de cookies)."
  exit 1
fi

TEMP="$(mktemp -t cookies-bot)"
trap 'rm -f "$TEMP" "$TEMP"-*' EXIT

# .backup copes with the database in use by an open Chrome; a plain cp may catch
# a half-written file.
if ! sqlite3 "$SOURCE" ".backup '$TEMP'" 2>/dev/null; then
  echo "❌ Não consegui ler os cookies do seu Chrome. Feche o Chrome e tente de novo."
  exit 1
fi

TOTAL=$(sqlite3 "$TEMP" "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%$DOMAIN';")
if [ "$TOTAL" = "0" ]; then
  echo "❌ Seu Chrome não tem cookies de $DOMAIN."
  echo "   Abra o site nele (e faça login, se for o caso) e rode de novo."
  exit 1
fi

cp "$TARGET" "$TARGET.bak" 2>/dev/null

# Merge instead of replace: swap only this domain's rows and keep the rest of
# the bot profile intact.
sqlite3 "$TARGET" <<SQL || { echo "❌ Falha ao mesclar os cookies."; exit 1; }
ATTACH DATABASE '$TEMP' AS source;
DELETE FROM cookies WHERE host_key LIKE '%$DOMAIN';
INSERT INTO cookies SELECT * FROM source.cookies WHERE host_key LIKE '%$DOMAIN';
DETACH DATABASE source;
SQL

echo "✅ $TOTAL cookies de $DOMAIN copiados pro perfil do bot."
echo "   Agora rode \`npm run chrome\`."
