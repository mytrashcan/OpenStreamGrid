FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY common/package.json common/package.json
COPY tracker/package.json tracker/package.json
COPY origin/package.json origin/package.json
COPY peer/package.json peer/package.json
RUN npm ci

COPY common common
COPY origin origin
RUN npm run build --workspace @openstreamgrid/common \
    && npm run build --workspace @openstreamgrid/origin \
    && npm prune --omit=dev

FROM debian:bookworm-slim AS ffmpeg
RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=ffmpeg /usr /usr
COPY --from=ffmpeg /etc/alternatives /etc/alternatives
COPY --from=build --chown=nonroot:nonroot /app/common/dist common/dist
COPY --from=build --chown=nonroot:nonroot /app/common/package.json common/package.json
COPY --from=build --chown=nonroot:nonroot /app/origin/dist origin/dist
COPY --from=build --chown=nonroot:nonroot /app/origin/package.json origin/package.json
COPY --from=build --chown=nonroot:nonroot /app/node_modules node_modules
ENV NODE_ENV=production
USER nonroot
CMD ["origin/dist/server.js"]
