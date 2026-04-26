FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --omit=dev

COPY bot.js ./
COPY packages/shared/index.js ./packages/shared/

CMD ["node", "bot.js"]
