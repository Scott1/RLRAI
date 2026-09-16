import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "evals/results/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ],
      "no-console": "off"
    }
  },
  {
    files: ["src/web/public/**/*.js"],
    languageOptions: {
      globals: {
        crypto: "readonly",
        document: "readonly",
        fetch: "readonly",
        localStorage: "readonly"
      }
    }
  }
];
