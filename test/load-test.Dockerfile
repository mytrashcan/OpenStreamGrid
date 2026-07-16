FROM node:22-bookworm-slim

WORKDIR /app

COPY --chown=node:node test/load-test.mjs ./load-test.mjs

USER node

EXPOSE 9090

ENTRYPOINT ["node", "load-test.mjs"]
