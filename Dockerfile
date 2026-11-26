# syntax=docker/dockerfile:1

# --- Stage 1: Build TypeScript server & browser vendor bundle ---
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY contracts ./contracts

RUN npm run build && npm prune --omit=dev

# --- Stage 2: Minimal non-root production runtime ---
FROM node:22-slim AS runner

WORKDIR /app

RUN groupadd --system --gid 1001 siphon \
  && useradd --system --uid 1001 --gid siphon --create-home siphon \
  && mkdir -p /data \
  && chown -R siphon:siphon /app /data

COPY --from=builder --chown=siphon:siphon /app/package.json ./package.json
COPY --from=builder --chown=siphon:siphon /app/node_modules ./node_modules
COPY --from=builder --chown=siphon:siphon /app/dist ./dist
COPY --from=builder --chown=siphon:siphon /app/public ./public
COPY --from=builder --chown=siphon:siphon /app/contracts ./contracts

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4420 \
    SIPHON_DATA_DIR=/data \
    SIPHON_TRUST_PROXY=true

EXPOSE 4420

VOLUME ["/data"]

USER siphon

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4420) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/src/server/index.js"]
