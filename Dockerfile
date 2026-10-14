FROM node:22.22.2-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
RUN npm ci
COPY . .
ARG VITE_PROGRAM_ID
ARG VITE_SOLANA_CLUSTER=mainnet-beta
ARG VITE_OWNER_RPC_URL
RUN npm run build

FROM node:22.22.2-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/build ./build
COPY migrations ./migrations
COPY scripts/container-entrypoint.sh /usr/local/bin/doubletake-entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
RUN chown -R node:node /app
RUN chmod 755 /usr/local/bin/doubletake-entrypoint
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/doubletake-entrypoint"]
