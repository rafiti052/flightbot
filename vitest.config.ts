import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["*.ts", "scripts/**/*.ts", ".agents/skills/tlc-spec-driven/scripts/**/*.ts"],
      exclude: ["types.ts", "vitest.config.ts", "tests/**"],
    },
  },
});
