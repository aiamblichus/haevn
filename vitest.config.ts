import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    // Agent worktrees live under .claude/worktrees; cli/ runs its own vitest.
    exclude: [...configDefaults.exclude, ".claude/**", "cli/**"],
  },
});
