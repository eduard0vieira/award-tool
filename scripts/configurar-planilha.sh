#!/bin/bash
# Cria a conta de serviço que escreve na planilha de buscas (ver src/outputs/spreadsheet.ts).
#
# Roda DEPOIS de `gcloud auth login` — é o único passo que precisa de você,
# porque envolve a sua conta Google.
#
# O que faz:
#   1. cria (ou reaproveita) um projeto no Google Cloud;
#   2. liga a API do Sheets nele;
#   3. cria a conta de serviço do bot;
#   4. baixa a chave JSON FORA do repositório (~/.config/award-tool/);
#   5. escreve GOOGLE_CREDENCIAIS no .env e mostra o e-mail a compartilhar.
#
# A chave nunca entra no git: é por isso que ela vai pra ~/.config e não pra cá.

set -e

PROJETO="${PROJETO_GCP:-bot-emissoes-vcc}"
CONTA="bot-emissoes"
DIR_CRED="$HOME/.config/award-tool"
ARQ_CRED="$DIR_CRED/credenciais-planilha.json"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  echo "❌ Nenhuma conta autenticada. Rode primeiro:  gcloud auth login"
  exit 1
fi

CONTA_ATIVA=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1)
echo "✅ Autenticado como $CONTA_ATIVA"

if gcloud projects describe "$PROJETO" > /dev/null 2>&1; then
  echo "✅ Projeto $PROJETO já existe — reaproveitando."
else
  echo "Criando projeto $PROJETO..."
  gcloud projects create "$PROJETO" --name="Bot de Emissoes"
fi

gcloud config set project "$PROJETO" > /dev/null
echo "Ligando a API do Google Sheets..."
gcloud services enable sheets.googleapis.com

EMAIL_CONTA="$CONTA@$PROJETO.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$EMAIL_CONTA" > /dev/null 2>&1; then
  echo "✅ Conta de serviço já existe."
else
  echo "Criando a conta de serviço..."
  gcloud iam service-accounts create "$CONTA" --display-name="Bot de Emissoes (planilha)"
fi

mkdir -p "$DIR_CRED"
chmod 700 "$DIR_CRED"

if [ -f "$ARQ_CRED" ]; then
  echo "✅ Chave já existe em $ARQ_CRED (não vou gerar outra à toa)."
else
  echo "Gerando a chave..."
  gcloud iam service-accounts keys create "$ARQ_CRED" --iam-account="$EMAIL_CONTA"
  chmod 600 "$ARQ_CRED"
fi

# .env: acrescenta só o que faltar, sem mexer no que já está lá.
touch "$ENV_FILE"
if ! grep -q "^GOOGLE_CREDENCIAIS=" "$ENV_FILE"; then
  {
    echo ""
    echo "# Planilha de buscas (ver src/outputs/spreadsheet.ts)"
    echo "GOOGLE_CREDENCIAIS=$ARQ_CRED"
  } >> "$ENV_FILE"
  echo "✅ GOOGLE_CREDENCIAIS escrito no .env"
else
  echo "ℹ️  GOOGLE_CREDENCIAIS já estava no .env — não mexi."
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo "Falta só a planilha, que é sua e fica na SUA conta:"
echo ""
echo "  1. Crie uma planilha em https://sheets.new"
echo "  2. Renomeie a primeira aba para: buscas"
echo "  3. Compartilhe com este e-mail, como EDITOR:"
echo ""
echo "       $EMAIL_CONTA"
echo ""
echo "  4. Copie o ID da URL (a parte entre /d/ e /edit) e rode:"
echo "       echo 'PLANILHA_ID=<id>' >> .env"
echo "────────────────────────────────────────────────────────────"
