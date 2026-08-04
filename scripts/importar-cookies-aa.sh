#!/bin/bash
# Copia SÓ os cookies de aa.com do seu Chrome normal pro perfil que o bot usa.
#
# Por que isso é necessário: a AA (Akamai) barra com "Access Denied" qualquer
# navegador que chegue sem os cookies dela — vale até pra um Chrome comum,
# sem automação nenhuma, quando o perfil é novo. O seu navegador de todo dia
# passa porque já tem esses cookies de quando você navegou lá. Aqui a gente
# leva essa mesma credencial de sessão pro perfil do bot.
#
# Só cookies com host_key de aa.com são copiados — nada de outros sites. Os
# valores continuam criptografados pelo Chrome; quem decifra é o próprio
# Chrome, via chaveiro do seu usuário (por isso funciona sem senha nenhuma).

PERFIL_BOT="${AA_CHROME_PERFIL:-$HOME/.chrome-bot-aa}"
ORIGEM="$HOME/Library/Application Support/Google/Chrome/Default/Cookies"
DESTINO="$PERFIL_BOT/Default/Cookies"

if [ ! -f "$ORIGEM" ]; then
  echo "❌ Não achei os cookies do seu Chrome em:"
  echo "   $ORIGEM"
  exit 1
fi

if [ ! -f "$DESTINO" ]; then
  echo "❌ O perfil do bot ainda não existe. Rode \`npm run chrome\` uma vez antes."
  exit 1
fi

if pgrep -f "user-data-dir=$PERFIL_BOT" > /dev/null; then
  echo "❌ A janela do bot está aberta — feche ela antes (o Chrome tranca o arquivo de cookies)."
  exit 1
fi

TEMP="$(mktemp -t cookies-aa)"
trap 'rm -f "$TEMP" "$TEMP"-*' EXIT

# .backup lida com o banco em uso pelo Chrome aberto; o cp direto pode pegar
# um arquivo pela metade.
if ! sqlite3 "$ORIGEM" ".backup '$TEMP'" 2>/dev/null; then
  echo "❌ Não consegui ler os cookies do seu Chrome. Feche o Chrome e tente de novo."
  exit 1
fi

TOTAL=$(sqlite3 "$TEMP" "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%aa.com';")
if [ "$TOTAL" = "0" ]; then
  echo "❌ Seu Chrome não tem cookies de aa.com. Abra o aa.com nele, faça uma busca e rode de novo."
  exit 1
fi

# Tudo que não for aa.com sai fora: o perfil do bot não recebe sessão de
# nenhum outro site.
sqlite3 "$TEMP" "DELETE FROM cookies WHERE host_key NOT LIKE '%aa.com';" || exit 1
sqlite3 "$TEMP" "VACUUM;" > /dev/null 2>&1

cp "$DESTINO" "$DESTINO.bak" 2>/dev/null
mv "$TEMP" "$DESTINO"
rm -f "$DESTINO-journal" "$DESTINO-wal" "$DESTINO-shm"

echo "✅ $TOTAL cookies de aa.com copiados pro perfil do bot."
echo "   Agora rode \`npm run chrome\` e faça a busca."
