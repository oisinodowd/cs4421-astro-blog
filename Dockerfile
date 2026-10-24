# ---- Stage 1: production dependencies ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
 
# ---- Stage 2: build (dist/client + dist/server) ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
 
# ---- Stage 3: runtime — server-side compute ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Production runs the app, it never installs anything - so drop the package
# managers. npm and corepack ship their own bundled dependencies (undici,
# brace-expansion), which the Trivy gate reports as fixable HIGH CVEs that no
# change in this repo can patch. Removing them shrinks the attack surface too.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
RUN mkdir -p /app/.astro/sessions && chown -R node:node /app
USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4321/api/health || exit 1
CMD ["node", "./dist/server/entry.mjs"]

