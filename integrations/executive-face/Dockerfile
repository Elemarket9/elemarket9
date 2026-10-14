FROM node:22-alpine
WORKDIR /srv/elemarket
COPY integrations/executive-face/ ./integrations/executive-face/
COPY src/modules/identity/internal/auth/executive/security.mjs ./src/modules/identity/internal/auth/executive/security.mjs
USER node
EXPOSE 8091
CMD ["node", "integrations/executive-face/server.mjs"]
