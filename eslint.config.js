import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  // ========== 全局忽略 ==========
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      '**/vitest.config.*',
      '**/vite.config.*',
      '**/drizzle.config.*',
      '**/*.d.ts',
    ],
  },

  // ========== JS 推荐规则 ==========
  js.configs.recommended,

  // ========== TypeScript 推荐规则 ==========
  ...tseslint.configs.recommended,

  // ========== Vue 推荐规则 (仅 .vue 文件) ==========
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
    },
  },

  // ========== 全局自定义规则 ==========
  {
    rules: {
      // ---- 风格 ----
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      indent: ['error', 2, { SwitchCase: 1 }],
      'comma-dangle': ['error', 'always-multiline'],
      'object-curly-spacing': ['error', 'always'],
      'array-bracket-spacing': ['error', 'never'],
      'computed-property-spacing': ['error', 'never'],

      // ---- 最佳实践 ----
      // 'no-console': 'warn',
      'no-unused-vars': 'off', // 由 @typescript-eslint/no-unused-vars 替代
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ========== Vue 专项覆盖 ==========
  {
    files: ['packages/client/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
      'vue/max-attributes-per-line': ['warn', {
        singleline: { max: 3 },
        multiline: { max: 1 },
      }],
    },
  },

  // ========== 服务端专项覆盖 ==========
  {
    files: ['packages/server/**/*.ts'],
    rules: {
      // 服务端使用 CommonJS，但代码中统一用 import/export
    },
  },
);
