import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  treeshake: true,
  dts: false,
  // sharp ships native binaries and must be loaded from node_modules at runtime.
  external: ["sharp"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
