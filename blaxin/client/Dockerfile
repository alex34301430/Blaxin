FROM node:20-slim AS build
WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json* ./

# Install all dependencies (including dev for Vite build)
RUN npm ci

# Copy source code and config
COPY . .

# Build the Vite app
RUN npm run build

# Production stage: serve with nginx
FROM nginx:alpine

# Copy built assets from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 5173

CMD ["nginx", "-g", "daemon off;"]
