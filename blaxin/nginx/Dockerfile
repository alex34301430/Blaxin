FROM nginx:alpine

# Install certbot for Let's Encrypt SSL certificates
RUN apk add --no-cache certbot

# Copy nginx configs
COPY nginx.conf /etc/nginx/conf.d/default.conf
# SSL config kept alongside for manual activation
COPY ssl.conf /etc/nginx/conf.d/ssl.conf

# Create certbot webroot
RUN mkdir -p /var/www/certbot

# Copy renewal hook to reload nginx after cert renewal
COPY renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
RUN chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

EXPOSE 80 443

# Start nginx in background, then run certbot renewal loop, then wait on nginx
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
