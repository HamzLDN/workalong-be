module.exports = {
  env: { node: true, es2022: true },
  extends: ['eslint:recommended'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-empty': 'warn',
    'no-control-regex': 'warn',
    'no-prototype-builtins': 'warn',
    'no-case-declarations': 'warn',
  },
  ignorePatterns: ['node_modules', 'coverage', 'scripts/**', '__tests__/**'],
};
