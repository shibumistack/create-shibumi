FROM oven/bun:alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:alpine
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
