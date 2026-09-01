#!/bin/sh
set -e

DOMAIN="${DOMAIN:-localhost}"
EMAIL="${CERTBOT_EMAIL:-}"

echo "🌐 Starting BLAXIN nginx reverse proxy..."

# Start nginx
nginx

# If a domain is configured and email is provided, obtain/renew certs
if [ "$DOMAIN" != "localhost" ] && [ -n "$EMAIL" ]; then
    echo "🔒 Domain set to $DOMAIN — checking SSL certificates..."

    # Check if we already have a cert
    if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
        echo "📜 No certificate found — requesting from Let's Encrypt..."
        certbot certonly \
            --webroot \
            --webroot-path=/var/www/certbot \
            --domain "$DOMAIN" \
            --email "$EMAIL" \
            --agree-tos \
            --non-interactive \
            --no-eff-email || {
            echo "⚠️  Certbot failed. Continuing with HTTP only."
            echo "   You can retry manually: docker compose run --rm certbot"
        }
    fi

    # If cert exists, activate the SSL config
    if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
        echo "🔐 SSL certificate found — enabling HTTPS..."
        # Uncomment the HTTPS server block in ssl.conf
        sed -i 's/^# server {/server {/' /etc/nginx/conf.d/ssl.conf
        sed -i 's/^#     /    /g' /etc/nginx/conf.d/ssl.conf
        sed -i 's/^# }/}/' /etc/nginx/conf.d/ssl.conf
        # Enable the redirect in the HTTP block
        sed -i 's/^    # return 301/    return 301/' /etc/nginx/conf.d/default.conf
        # Reload nginx to pick up SSL config
        nginx -s reload
        echo "✅ HTTPS enabled on https://$DOMAIN"
    fi

    # Start certbot renewal loop in background (every 12 hours)
    echo "🔄 Starting certbot renewal loop (every 12h)..."
    while true; do
        sleep 43200
        echo "🔄 Running certbot renewal..."
        certbot renew --quiet --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    done &
else
    echo "ℹ️  No DOMAIN/CERTBOT_EMAIL set — running HTTP only."
    echo "   To enable SSL, set DOMAIN and CERTBOT_EMAIL in .env"
fi

echo "✅ BLAXIN nginx ready on port 80"

# Keep nginx in foreground
exec nginx -g 'daemon off;'
