# --- stage 1: build ---
FROM node:20-alpine AS build
WORKDIR /app

# Use China npm mirror to avoid GFW / fake-IP DNS issues
RUN npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# --- stage 2: serve ---
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
# 127.0.0.1, not localhost: in this image `localhost` resolves to ::1 first
# and nginx only listens on IPv4, so the probe got "Connection refused" and
# the container sat permanently (and wrongly) `unhealthy` while serving fine.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1
