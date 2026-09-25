FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./

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

CMD ["node", "dist/worker/main.js"]

FROM runtime AS api

CMD ["node", "dist/api/server.js"]