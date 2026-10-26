# The web app for one organization (apps/web), as compose.yaml runs it. It builds the manual extension download for
# one origin, BETTER_AUTH_URL, so build an image per origin: the app must run at the origin it was built for.
FROM node:24-bookworm-slim
COPY --from=oven/bun:1.3.14-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node . .
RUN bun install --frozen-lockfile

ARG BETTER_AUTH_URL=http://localhost:3000
# The rest of the configuration is read when the container starts.
RUN bun run build:web && rm -rf apps/extension/.output ~/.bun/install/cache

ENV NODE_ENV=production MIGRATE_ON_START=true
WORKDIR /app/apps/web
EXPOSE 3000
# What `bun run start:web` runs, as the container's first process, so it gets the stop signal.
CMD ["node", "--import", "tsx", "server.ts"]
