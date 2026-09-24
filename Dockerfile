FROM node:22-bookworm-slim AS base

WORKDIR /app

# Prisma 6 precisa do OpenSSL disponível durante geração e execução do client.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./

# O prebuild gera o Prisma Client antes da compilação TypeScript.
RUN npm run build

FROM base AS runtime

ENV NODE_ENV=production \
    PORT=4100 \
    HOST=0.0.0.0

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 4100

FROM runtime AS worker

HEALTHCHECK NONE
CMD ["node", "dist/worker/main.js"]

FROM runtime AS api

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4100) + '/ready').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/api/server.js"]
