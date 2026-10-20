# Pinned by digest (multi-arch index); Dependabot proposes updates.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# The app has no dependencies: drop package managers to shrink the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
# Only the public app files (root-owned, read-only for the runtime user). config.js is never copied.
COPY server.js index.html app.js app.css theme.js fonts.css sw.js manifest.webmanifest favicon.svg *.png *.woff2 ./

ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/media/health || exit 1

CMD ["node", "server.js"]
