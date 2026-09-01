#!/bin/sh
# Called by certbot after successful certificate renewal
echo "🔄 Certificate renewed — reloading nginx..."
nginx -s reload
echo "✅ nginx reloaded with new certificate"
