import globals from "globals";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    files: ["static/**/*.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // External libraries (loaded via script tags)
        "Contextual": "readonly",
        "Toastify": "readonly",
      },
    },
    rules: {
      // Error prevention
      "no-undef": "error",
      "no-unused-vars": ["warn", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
      }],
      "no-redeclare": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": ["warn", { "allowEmptyCatch": true }],
      "no-constant-condition": ["warn", { "checkLoops": false }],
      "no-extra-boolean-cast": "off",
      "no-regex-spaces": "off",

      // Code quality
      "eqeqeq": ["warn", "always", { "null": "ignore" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-with": "error",
      "no-new-wrappers": "warn",
      "no-caller": "warn",
      "no-extend-native": "warn",

      // Style (optional - mostly warnings)
      "semi": ["warn", "always"],
      "no-trailing-spaces": "warn",
      "comma-dangle": ["warn", "always-multiline"],
      "space-infix-ops": "warn",
      "keyword-spacing": "warn",
      "space-before-blocks": "warn",
      "brace-style": ["warn", "1tbs"],
      "indent": "off", // Disabled due to mixed tab/space usage in existing code
      "quotes": "off",
      "camelcase": "off",
      "no-underscore-dangle": "off",
      "no-var": "off", // Allow var for legacy code
      "prefer-const": "warn",
      "no-console": "off", // console is used for debugging
    },
  },
  {
    ignores: [
      "static/third-party/**",
      "node_modules/**",
    ],
  },
];
