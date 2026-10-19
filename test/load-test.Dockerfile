FROM node:22-bookworm-slim

WORKDIR /app

# Keep the repository layout: load-test.mjs imports ../scripts/benchmark-data.mjs.
COPY --chown=node:node scripts/benchmark-data.mjs ./scripts/benchmark-data.mjs
COPY --chown=node:node test/load-test.mjs ./test/load-test.mjs

USER node

EXPOSE 9090

ENTRYPOINT ["node", "test/load-test.mjs"]
