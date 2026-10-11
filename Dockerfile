# syntax=docker/dockerfile:1

# ---- dependencies ----------------------------------------------------------
# Installed in a separate stage so the layer is cached until the lockfile
# changes, and so npm itself never lands in the runtime image.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
# The deployed service listens on 4650. config.js reads PORT from the
# environment, and because NODE_ENV=production the real environment wins over
# any .env file (none is copied in -- see .dockerignore). Override at run time
# with `-e PORT=...` if the platform assigns the port for you.
ENV PORT=4650

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
# OCR language data (Thai + English) for reading slips when no slip provider is connected.
COPY assets ./assets

# Run unprivileged; the node image already ships a non-root `node` user.
USER node

EXPOSE 4650

# Hits /healthz, which is liveness-only and never touches the database, so a
# database outage does not get the container killed. Readiness is /readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4650)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node runs as PID 1 and receives SIGTERM directly -- server.js
# registers a handler and drains the pool before exiting.
# DATABASE_URL must be injected at run time; no credentials are baked in.
CMD ["node", "src/server.js"]
