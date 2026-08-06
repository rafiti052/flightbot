# Must match the playwright version resolved in pnpm-lock.yaml, or the browser
# binaries baked into this image won't match what the package expects at runtime.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY bot.ts scraper.ts ui.ts types.ts ./
COPY scripts ./scripts

CMD ["pnpm", "exec", "tsx", "bot.ts"]
