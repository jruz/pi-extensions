import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "extensions/*.ts!",
    "extensions/*/index.ts!",
    "tests/fixtures/**/*.ts",
    "scripts/*.ts",
    "!**/*.test.ts",
  ],
  project: ["**/*.ts"],
  ignoreDependencies: ["prettier"],
};

export default config;
