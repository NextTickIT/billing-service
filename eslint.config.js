import init from 'eslint-config-metarhia';

export default [
  ...init,
  {
    files: [
      '*.config.js',
      'server.js',
      'routes/**/*.js',
      'shared/**/*.mjs',
      'static/**/*.mjs',
    ],
    languageOptions: {
      sourceType: 'module',
    },
    rules: {
      'max-len': 'off',
    },
  },
  {
    files: ['static/**/*.mjs'],
    languageOptions: {
      globals: {
        customElements: 'readonly',
      },
    },
    rules: {
      strict: 'off',
    },
  },
];
