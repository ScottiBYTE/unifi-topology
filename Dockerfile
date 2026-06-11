FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/* /root/.npm


FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3051
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY server.js ./
COPY public ./public
COPY package*.json ./
COPY config.example.json ./config.example.json

RUN mkdir -p /app/data

EXPOSE 3051

CMD ["node", "server.js"]
