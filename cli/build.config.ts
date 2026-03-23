import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: ["src/index"],
  clean: true,
  declaration: true,
  rollup: {
    emitCJS: false,
    inlineDependencies: true,
  },
  externals: [],
  hooks: {
    "rollup:options": (_ctx, options) => {
      // Alias #shared/* to ../src/* for type imports
      if (Array.isArray(options.input)) {
        // Already handled by entries
      }
    },
  },
});
