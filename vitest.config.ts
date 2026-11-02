import { defineConfig } from "vitest/config";

// Tests sit next to the code they cover; snapshot fixtures live in src/__fixtures__/.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
