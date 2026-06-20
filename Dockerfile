# syntax=docker/dockerfile:1

# ---- deps: install production dependencies with a frozen lockfile ----------
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime: slim image with only what the bot needs to run ---------------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# Writable home for persisted log-monitor state. Created (and owned by `bun`)
# in the image so the named volume mounted here inherits that ownership on
# first use — otherwise a fresh volume is root-owned and uid 1000 can't write.
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]

# Run as the unprivileged built-in `bun` user (uid 1000), never root.
USER bun

# Bun executes the TypeScript entry directly — no build/transpile step.
CMD ["bun", "run", "src/index.ts"]
