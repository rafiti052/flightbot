FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/bot/package.json ./apps/bot/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --omit=dev

COPY apps/bot/ ./apps/bot/
COPY packages/shared/ ./packages/shared/

ENV FLIGHTBOT_DATA_DIR=/data

CMD ["node", "apps/bot/bot.js"]
