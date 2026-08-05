# Must match the playwright version resolved in pnpm-lock.yaml, or the browser
# binaries baked into this image won't match what the package expects at runtime.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY bot.js scraper.js ./
COPY scripts/ ./scripts/

CMD ["node", "bot.js"]
