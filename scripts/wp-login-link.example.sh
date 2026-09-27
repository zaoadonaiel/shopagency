#!/usr/bin/env bash
# EXAMPLE ONLY. Called when the contractor marks the job done:  wp-login-link.sh <orderId> <username>
# Must print ONE line of JSON: {"loginUrl":"..."}  where the URL lets the buyer set their WordPress password once.
set -euo pipefail
ORDER_ID="$1"; USERNAME="$2"
HOST="order-${ORDER_ID}.${STAGING_DOMAIN:?set STAGING_DOMAIN}"
cd "/var/www/${HOST}"
# WordPress's own password-reset key = a one-time link.
KEY="$(wp eval "echo get_password_reset_key(get_user_by('login','${USERNAME}'));" --allow-root)"
printf '{"loginUrl":"https://%s/wp-login.php?action=rp&key=%s&login=%s"}\n' "$HOST" "$KEY" "$USERNAME"
