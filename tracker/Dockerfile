FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY common/package.json common/package.json
COPY tracker/package.json tracker/package.json
COPY origin/package.json origin/package.json
COPY peer/package.json peer/package.json
RUN npm ci

COPY common common
COPY tracker tracker
RUN npm run build --workspace @openstreamgrid/common \
    && npm run build --workspace @openstreamgrid/tracker \
    && npm prune --omit=dev

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /app/common/dist common/dist
COPY --from=build --chown=nonroot:nonroot /app/common/package.json common/package.json
COPY --from=build --chown=nonroot:nonroot /app/tracker/dist tracker/dist
COPY --from=build --chown=nonroot:nonroot /app/tracker/package.json tracker/package.json
COPY --from=build --chown=nonroot:nonroot /app/node_modules node_modules
ENV NODE_ENV=production
USER nonroot
CMD ["tracker/dist/server.js"]
