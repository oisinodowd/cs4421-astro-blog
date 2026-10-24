# ---- Stage 1: production dependencies ----
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
 
# ---- Stage 2: build (dist/client + dist/server) ----
FROM node:25-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
 
# ---- Stage 3: runtime — server-side compute ----
FROM node:25-alpine AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/.astro/sessions && chown -R node:node /app
USER node
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4321/api/health || exit 1
CMD ["node", "./dist/server/entry.mjs"]

