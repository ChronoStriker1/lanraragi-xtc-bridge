# syntax=docker/dockerfile:1

FROM oven/bun:1.2.0 AS web-builder
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile

COPY apps ./apps
RUN bun run --cwd apps/web build

FROM oven/bun:1.2.0 AS runtime
WORKDIR /app/apps/server

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    python3-pil \
  && rm -rf /var/lib/apt/lists/*

COPY apps/server/package.json ./package.json
RUN bun install --production

COPY apps/server/src ./src
COPY apps/server/tsconfig.json ./tsconfig.json
COPY apps/server/.env.example ./.env.example
COPY tools /app/tools
COPY --from=web-builder /app/apps/web/dist /app/apps/web/dist

RUN mkdir -p /app/apps/server/logs /app/apps/server/.runtime /app/apps/server/.tmp

ENV PORT=3000 \
  SERVER_PUBLIC_URL=http://localhost:3000 \
  LANRARAGI_BASE_URL=http://localhost:3001 \
  LANRARAGI_API_KEY= \
  XTEINK_BASE_URL=http://xteink.local \
  DEVICE_SETTINGS_FILE=.runtime/device-settings.json \
  CBZ2XTC_PATH=/app/tools/cbz2xtc/cbz2xtc.py \
  PNG2XTC_PATH=/app/tools/epub2xtc/png2xtc.py \
  PYTHON_BIN=python3 \
  TEMP_ROOT=.tmp \
  PAGE_FETCH_CONCURRENCY=6 \
  GLOBAL_PAGE_FETCH_CONCURRENCY=8 \
  USE_LRR_PAGE_EXTRACTION=true \
  LOG_FILE=logs/bridge.log

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
