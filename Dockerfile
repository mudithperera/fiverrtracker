# RankPeek API + tracking worker.
#
# Built on Playwright's own image because the worker drives a real Chromium and
# the browser's system dependencies (fonts, nss, libdrm and friends) are tedious
# to assemble by hand on a plain node base.
#
# The tag must match the playwright version pinned in server/package.json — a
# mismatch fails at runtime with "Executable doesn't exist", which is a miserable
# thing to discover in production.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# The worker imports the extension's own classification code from src/lib, so the
# image needs both trees. That sharing is deliberate: see server/README.md.
COPY src ./src
COPY server/src ./server/src

WORKDIR /app/server

# Playwright's image ships a non-root user; a browser should not run as root.
USER pwuser

EXPOSE 8787

# Overridden to `node src/worker/index.js` for the worker process.
CMD ["node", "src/index.js"]
