FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3051

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY config.example.json ./config.example.json

RUN mkdir -p /app/data

EXPOSE 3051

CMD ["node", "server.js"]
