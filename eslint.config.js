/**
 * ESLint 扁平配置。
 *
 * 用非类型化规则集（`recommended`）而不是 `recommendedTypeChecked`：
 * 后者要开 projectService、全量跑一次程序分析，对本项目这点体积收益不划算，
 * 真正的类型错误已经由 `tsc --noEmit` 兜住了（CI 里两道都跑）。
 */

import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      "coverage/",
      // 运行产物 / 大文件目录，不是源码
      "models/",
      "vector-db/",
      "workspace/",
      "traces/",
      "history/",
      "memory/",
      "eval_reports/",
      ".cache/",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    files: ["**/*.ts"],
    plugins: { "@stylistic": stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // TS 自己就会报未定义标识符，ESLint 的 no-undef 在 TS 上只会误报（类型、接口名等）
      "no-undef": "off",
      // 既有约定：行宽 100
      "@stylistic/max-len": [
        "error",
        { code: 100, tabWidth: 2, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true },
      ],
      // 未用的参数用下划线前缀显式标记「故意不用」
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      eqeqeq: ["error", "smart"],
      "no-console": "error",
      "prefer-const": "error",
    },
  },

  {
    // 浏览器侧代码（Web 控制台，零构建直接跑）
    // sourceType 用 module：index.html 里是 <script type="module">，app.js 会 import markdown.js
    files: ["public/**/*.js"],
    plugins: { "@stylistic": stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "@stylistic/max-len": [
        "error",
        { code: 100, tabWidth: 2, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true },
      ],
    },
  },

  {
    // 命令行脚本：允许往 stdout 写
    files: ["scripts/**/*.ts", "src/cli.ts", "tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
