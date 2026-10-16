# Portable modular-monolith build. No external-provider names in app policy.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_ELEMARKET_MARKETPLACE_ORIGIN
ARG VITE_ELEMARKET_SELLER_ORIGIN
ARG VITE_ELEMARKET_PROVIDER_ORIGIN
ARG VITE_ELEMARKET_PUBLIC_MEDIA_ORIGINS
ENV VITE_ELEMARKET_MARKETPLACE_ORIGIN=$VITE_ELEMARKET_MARKETPLACE_ORIGIN \
    VITE_ELEMARKET_SELLER_ORIGIN=$VITE_ELEMARKET_SELLER_ORIGIN \
    VITE_ELEMARKET_PROVIDER_ORIGIN=$VITE_ELEMARKET_PROVIDER_ORIGIN \
    VITE_ELEMARKET_PUBLIC_MEDIA_ORIGINS=$VITE_ELEMARKET_PUBLIC_MEDIA_ORIGINS
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=8080
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/migrations.sha256.json ./migrations.sha256.json
COPY --from=builder /app/config ./config
COPY --from=builder /app/src ./src
USER node
EXPOSE 8080
CMD ["node", "scripts/start.mjs"]
