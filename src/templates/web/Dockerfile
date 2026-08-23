FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Major-pinned: minors and patches flow, a future Bun 2 cannot break deploys.
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./
# Production mode: extensions gate security behavior on this. Never unset it.
ENV NODE_ENV=production
USER bun
EXPOSE 3000
CMD ["bun", "dist/server.js"]
