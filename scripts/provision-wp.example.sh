#!/usr/bin/env bash
# EXAMPLE ONLY. Haseeb: adapt this to the real hosting (RunCloud, Cloudways, CyberPanel, plain VPS, etc.).
# Called by the shop when a contractor claims a job:  provision-wp.sh <orderId> <businessName> <domainOrEmpty>
# Must print ONE line of JSON on stdout: {"siteUrl":"...","adminUrl":"...","username":"..."}
set -euo pipefail
ORDER_ID="$1"; BUSINESS="$2"; DOMAIN="${3:-}"

SLUG="order-${ORDER_ID}"
HOST="${SLUG}.${STAGING_DOMAIN:?set STAGING_DOMAIN in the environment}"   # a staging subdomain you control
WEBROOT="/var/www/${HOST}"
USERNAME="client${ORDER_ID}"

# 1. Create a database and WordPress files (replace with your hosting panel's API/CLI if you use one).
DB_NAME="wp_${ORDER_ID}"; DB_PASS="$(openssl rand -hex 16)"
mysql -e "CREATE DATABASE \`${DB_NAME}\`; CREATE USER '${DB_NAME}'@'localhost' IDENTIFIED BY '${DB_PASS}'; GRANT ALL ON \`${DB_NAME}\`.* TO '${DB_NAME}'@'localhost';"
mkdir -p "$WEBROOT" && cd "$WEBROOT"
wp core download --allow-root >/dev/null
wp config create --dbname="$DB_NAME" --dbuser="$DB_NAME" --dbpass="$DB_PASS" --allow-root >/dev/null
wp core install --url="https://${HOST}" --title="$BUSINESS" --admin_user="$USERNAME" \
   --admin_password="$(openssl rand -hex 16)" --admin_email="wp-${ORDER_ID}@${STAGING_DOMAIN}" --skip-email --allow-root >/dev/null

# 2. TODO: create the nginx/Apache vhost, issue the SSL certificate, and install the Avada theme/plugins here.

printf '{"siteUrl":"https://%s","adminUrl":"https://%s/wp-admin","username":"%s"}\n' "$HOST" "$HOST" "$USERNAME"
