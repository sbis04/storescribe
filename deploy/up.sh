#!/usr/bin/env bash
# Creates (or reuses) the storescribe Droplet and deploys the app. Billing runs until deploy/down.sh.
# Needs: doctl (authenticated), an SSH key at $KEY, and ../.env with DATABASE_URL and MODEL_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=storescribe KEY=${KEY:-~/.ssh/leafpeep_ed25519} REGION=${REGION:-tor1} SIZE=${SIZE:-s-1vcpu-1gb}
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
grep -q '^MODEL_KEY=.\+' .env || { echo "Set MODEL_KEY in .env first"; exit 1; }

IP=$(doctl compute droplet list --tag-name "$NAME" --format PublicIPv4 --no-header | head -1)
if [[ -z "$IP" ]]; then
  KEY_ID=$(doctl compute ssh-key list --format ID,Name --no-header | awk '$2=="storescribe-deploy"{print $1}')
  [[ -n "$KEY_ID" ]] || KEY_ID=$(doctl compute ssh-key import storescribe-deploy --public-key-file "$KEY.pub" --format ID --no-header)
  echo "Creating Droplet ($SIZE in $REGION)…"
  IP=$(doctl compute droplet create "$NAME" --region "$REGION" --size "$SIZE" --image ubuntu-24-04-x64 \
    --ssh-keys "$KEY_ID" --user-data-file deploy/cloud-init.yml --enable-monitoring --tag-name "$NAME" \
    --wait --format PublicIPv4 --no-header)
fi
echo "Droplet: $IP"
echo "Waiting for Docker…"
until $SSH root@"$IP" 'test -f /root/cloud-init-done && docker --version' >/dev/null 2>&1; do sleep 10; done

rsync -az --delete -e "$SSH" --exclude node_modules --exclude .git --exclude .drafts --exclude docs ./ root@"$IP":/opt/storescribe/
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2- || true)
if [[ -n "$DOMAIN" ]]; then SITE_HOST=$DOMAIN ALT_HOST=$IP.sslip.io; else SITE_HOST=$IP.sslip.io ALT_HOST=http://unused.invalid:81; fi
# On the Droplet the model is Gemma 4 31B on DigitalOcean serverless inference, whatever .env says locally.
REMOTE_ENV="sed -i -e '/^SITE=/d' -e '/^ALT_SITE=/d' -e '/^MODEL_API=/d' -e '/^MODEL_URL=/d' -e '/^MODEL_NAME=/d' -e '/^PORT=/d' .env && printf 'SITE=%s\nALT_SITE=%s\nMODEL_API=openai\nMODEL_URL=https://inference.do-ai.run/v1\nMODEL_NAME=gemma-4-31B-it\n' $SITE_HOST $ALT_HOST >> .env"
$SSH root@"$IP" "cd /opt/storescribe && $REMOTE_ENV && chmod 600 .env && cd deploy && docker compose --env-file ../.env up -d --build"
until curl -fsS "https://$SITE_HOST/healthz" >/dev/null 2>&1; do sleep 5; done
echo "Live: https://$SITE_HOST"
