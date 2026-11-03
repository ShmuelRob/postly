# syntax=docker/dockerfile:1.7
# One image for every process (docs/deployment.md): `web` (Fastify), `worker` (pg-boss) and
# `migrate` (the migration job), chosen by the command. Node 26 with Playwright Chromium and sharp.

ARG NODE_VERSION=26

# --- build: compile src/ to dist/ (the test, playground and simulator contract code stays out) ---
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- deps: production node_modules only (sharp brings its prebuilt libvips) ---
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime ---
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
