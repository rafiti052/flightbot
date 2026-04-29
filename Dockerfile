FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot/package.json ./apps/bot/
COPY packages/shared/package.json ./packages/shared/
RUN corepack enable && pnpm install --filter @flightbot/bot... --prod --frozen-lockfile

COPY apps/bot/ ./apps/bot/
COPY packages/shared/ ./packages/shared/

ENV FLIGHTBOT_DATA_DIR=/data

CMD ["node", "apps/bot/bot.js"]
