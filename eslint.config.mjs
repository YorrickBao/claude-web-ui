import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import * as reactHooks from "eslint-plugin-react-hooks";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "server/data/**",
    "web/*.config.ts",
    "*.config.mjs",
    "web/postcss.config.js",
  ]),
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    files: ["server/**/*.ts", "web/**/*.ts", "web/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-hooks 7.x 实验性规则较激进，先关闭避免误报
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      // 全面禁止 any：显式 / 隐式都不允许
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // 这些规则对现有代码风格影响较大，先关闭
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
    },
  },
]);
