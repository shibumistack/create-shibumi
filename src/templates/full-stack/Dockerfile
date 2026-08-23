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
COPY src/db/migrations ./dist/migrations
COPY public ./public
COPY package.json ./
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV DB_PATH=/data/app.db
EXPOSE 3000
CMD ["bun", "dist/server.js"]
