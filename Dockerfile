FROM node:22-alpine

WORKDIR /app
# Only the app files: config.js (local key) is never copied into the image.
COPY server.js index.html sw.js manifest.webmanifest favicon.svg *.png ./

ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/media/health || exit 1

CMD ["node", "server.js"]
