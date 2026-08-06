#!/bin/bash
# Copia SÓ os cookies de um domínio do seu Chrome normal pro perfil que o bot
# usa. Uso:
#
#   bash scripts/importar-cookies.sh aa.com
#   bash scripts/importar-cookies.sh latamairlines.com
#
# Pra que serve:
# - aa.com: a Akamai barra com "Access Denied" qualquer navegador que chegue
#   sem os cookies dela — vale até pra um Chrome comum, sem automação, com
#   perfil novo. Levar os cookies do seu navegador de todo dia resolve.
# - latamairlines.com: a busca em milhas exige conta logada. Trazendo os
#   cookies de sessão, o bot herda o SEU login sem precisar de senha nenhuma
#   guardada em lugar algum.
#
# Só o domínio pedido é copiado — cookies de outros sites do seu navegador não
# saem daqui. E os já existentes no perfil do bot (de outros domínios) são
# preservados, então dá pra importar aa.com e latamairlines.com sem um apagar
# o outro. Os valores continuam criptografados pelo Chrome; quem decifra é o
# próprio Chrome, pelo chaveiro do seu usuário.

DOMINIO="${1:-}"
if [ -z "$DOMINIO" ]; then
  echo "Uso: bash scripts/importar-cookies.sh <dominio>"
  echo "Ex.: bash scripts/importar-cookies.sh latamairlines.com"
  exit 1
fi

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

TEMP="$(mktemp -t cookies-bot)"
trap 'rm -f "$TEMP" "$TEMP"-*' EXIT

# .backup lida com o banco em uso pelo Chrome aberto; o cp direto pode pegar
# um arquivo pela metade.
if ! sqlite3 "$ORIGEM" ".backup '$TEMP'" 2>/dev/null; then
  echo "❌ Não consegui ler os cookies do seu Chrome. Feche o Chrome e tente de novo."
  exit 1
fi

TOTAL=$(sqlite3 "$TEMP" "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%$DOMINIO';")
if [ "$TOTAL" = "0" ]; then
  echo "❌ Seu Chrome não tem cookies de $DOMINIO."
  echo "   Abra o site nele (e faça login, se for o caso) e rode de novo."
  exit 1
fi

cp "$DESTINO" "$DESTINO.bak" 2>/dev/null

# Mescla em vez de substituir: troca só as linhas desse domínio e mantém o
# resto do perfil do bot intacto.
sqlite3 "$DESTINO" <<SQL || { echo "❌ Falha ao mesclar os cookies."; exit 1; }
ATTACH DATABASE '$TEMP' AS origem;
DELETE FROM cookies WHERE host_key LIKE '%$DOMINIO';
INSERT INTO cookies SELECT * FROM origem.cookies WHERE host_key LIKE '%$DOMINIO';
DETACH DATABASE origem;
SQL

echo "✅ $TOTAL cookies de $DOMINIO copiados pro perfil do bot."
echo "   Agora rode \`npm run chrome\`."
