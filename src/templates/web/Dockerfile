FROM oven/bun:alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

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
COPY public ./public
COPY package.json ./
USER bun
EXPOSE 3000
CMD ["bun", "dist/server.js"]
