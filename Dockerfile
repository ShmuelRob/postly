# syntax=docker/dockerfile:1.7
# Two targets from one file, so they share the dependency layers (docs/deployment.md, CI):
# - `runtime` (the default, last stage): the product image for every process, `web` (Fastify),
#   `worker` (pg-boss), `console` and `migrate` (the migration job), chosen by the command. Node 26
#   with Playwright Chromium and sharp. It never holds playground or test code: only its stages copy
#   into it, and none of them copies playground/ or test/.
# - `sandbox`: the dev sandbox (WP-51, docs/deployment.md "The sandbox"), the playground's chat, mock
#   feed and mock checkout for the deployed dev on the simulators. Deployed only to dev.

ARG NODE_VERSION=26

# --- install: every dependency, for the compile stages ---
FROM node:${NODE_VERSION}-bookworm-slim AS install
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

# --- build: compile src/ to dist/ (the test, playground and simulator contract code stays out) ---
FROM install AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- sandbox-build: src/ and the sandbox entry point, plus the sandbox UI (Vite) ---
FROM install AS sandbox-build
COPY tsconfig.json tsconfig.build.json tsconfig.sandbox.json ./
COPY src ./src
COPY playground ./playground
# Types only: the sandbox's e2e report helpers name the report's record types.
COPY test/e2e/harness/record.ts ./test/e2e/harness/record.ts
RUN npx tsc -p tsconfig.sandbox.json && npx vite build --config playground/sandbox/vite.config.ts

# --- deps: production node_modules only (sharp brings its prebuilt libvips) ---
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- sandbox: the design renderer is created but never renders here (the sandbox only signs up), so no Chromium ---
FROM node:${NODE_VERSION}-bookworm-slim AS sandbox
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=sandbox-build /app/dist ./dist
COPY assets ./dist/assets
USER node
EXPOSE 8080
ENTRYPOINT ["node", "--enable-source-maps", "dist/playground/sandbox/main.js"]

# --- runtime: the product image (the default target, so it stays the last stage) ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# Chromium and its system libraries, at the version the installed playwright package expects.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chmod -R a+rX /ms-playwright
# dist/src/... resolves fonts and migrations relative to itself (../../../assets, ../../drizzle).
COPY --from=build /app/dist ./dist
COPY assets ./dist/assets
COPY drizzle ./dist/drizzle

# Non-root: the `node` user from the base image (uid 1000).
USER node
EXPOSE 8080
ENTRYPOINT ["node", "--enable-source-maps", "dist/src/main.js"]
CMD ["web"]
