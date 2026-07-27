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
  {
    // typed linting 只作用于有 projectService 的 TS 文件。
    // .mjs / .js（如 cli.mjs）只走上面的 eslint.configs.recommended，
    // 不命中 typed 规则，避免 "rule requires type information" 直接崩溃中止。
    files: ["server/**/*.ts", "web/**/*.ts", "web/**/*.tsx"],
    extends: tseslint.configs.recommendedTypeChecked,
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
