FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY public ./public
COPY server.js worker.js ./

ENV NODE_ENV=production

# API by default; the worker service overrides the command in docker-compose.
CMD ["node", "server.js"]
