import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup-tree-sitter.ts"],
  },
  bench: {
    // Bench files only; `vitest bench` must not pick up *.test.ts.
    include: ["tests/**/*.bench.ts"],
  },
});
