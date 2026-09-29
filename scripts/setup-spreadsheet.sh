#!/bin/bash
# Creates the service account that writes to the searches spreadsheet (see
# src/outputs/spreadsheet.ts). Run it AFTER `gcloud auth login`, the only step
# that needs you, since it involves your Google account.
#
# What it does:
#   1. creates (or reuses) a Google Cloud project;
#   2. enables the Sheets API on it;
#   3. creates the bot's service account;
#   4. downloads the JSON key OUTSIDE the repository (~/.config/award-tool/);
#   5. writes GOOGLE_CREDENTIALS to .env and prints the e-mail to share with.
#
# The key never enters git: that is why it goes to ~/.config and not here.

set -e

PROJECT="${GCP_PROJECT:-bot-emissoes-vcc}"
ACCOUNT="bot-emissoes"
CREDENTIALS_DIR="$HOME/.config/award-tool"
# Kept as it is: an existing key file on disk is reused instead of generating another.
CREDENTIALS_FILE="$CREDENTIALS_DIR/credenciais-planilha.json"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  echo "❌ Nenhuma conta autenticada. Rode primeiro:  gcloud auth login"
  exit 1
fi

ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1)
echo "✅ Autenticado como $ACTIVE_ACCOUNT"

if gcloud projects describe "$PROJECT" > /dev/null 2>&1; then
  echo "✅ Projeto $PROJECT já existe — reaproveitando."
else
  echo "Criando projeto $PROJECT..."
  gcloud projects create "$PROJECT" --name="Bot de Emissoes"
fi

gcloud config set project "$PROJECT" > /dev/null
echo "Ligando a API do Google Sheets..."
gcloud services enable sheets.googleapis.com

ACCOUNT_EMAIL="$ACCOUNT@$PROJECT.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$ACCOUNT_EMAIL" > /dev/null 2>&1; then
  echo "✅ Conta de serviço já existe."
else
  echo "Criando a conta de serviço..."
  gcloud iam service-accounts create "$ACCOUNT" --display-name="Bot de Emissoes (planilha)"
fi

mkdir -p "$CREDENTIALS_DIR"
chmod 700 "$CREDENTIALS_DIR"

if [ -f "$CREDENTIALS_FILE" ]; then
  echo "✅ Chave já existe em $CREDENTIALS_FILE (não vou gerar outra à toa)."
else
  echo "Gerando a chave..."
  gcloud iam service-accounts keys create "$CREDENTIALS_FILE" --iam-account="$ACCOUNT_EMAIL"
  chmod 600 "$CREDENTIALS_FILE"
fi

# Appends only what is missing to .env, leaving what is there untouched.
touch "$ENV_FILE"
if ! grep -q "^GOOGLE_CREDENTIALS=" "$ENV_FILE"; then
  {
    echo ""
    echo "# Planilha de buscas (ver src/outputs/spreadsheet.ts)"
    echo "GOOGLE_CREDENTIALS=$CREDENTIALS_FILE"
  } >> "$ENV_FILE"
  echo "✅ GOOGLE_CREDENTIALS escrito no .env"
else
  echo "ℹ️  GOOGLE_CREDENTIALS já estava no .env — não mexi."
fi

echo ""
echo "────────────────────────────────────────────────────────────"
echo "Falta só a planilha, que é sua e fica na SUA conta:"
echo ""
echo "  1. Crie uma planilha em https://sheets.new"
echo "  2. Renomeie a primeira aba para: buscas"
echo "  3. Compartilhe com este e-mail, como EDITOR:"
echo ""
echo "       $ACCOUNT_EMAIL"
echo ""
echo "  4. Copie o ID da URL (a parte entre /d/ e /edit) e rode:"
echo "       echo 'SPREADSHEET_ID=<id>' >> .env"
echo "────────────────────────────────────────────────────────────"
