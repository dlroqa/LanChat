'use strict';

// Lint config, in four parts because this repo is four different environments.
//
//   src/main, src/preload, scripts, test  — CommonJS, Node globals
//   src/renderer                          — ESM + JSX, browser globals
//   vite.config.js                        — ESM in a "type": "commonjs" package
//
// That last one is why a single flat config fails: parsing the root as script
// throws on its `import`. Each block below sets sourceType explicitly rather
// than letting the package type decide.
//
// The rules are deliberately close to "things that are almost certainly wrong"
// rather than a style guide. Formatting is not linted here — see the note on
// `npm run format` in package.json.

const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');
const react = require('eslint-plugin-react');

const IGNORED = ['dist/**', 'release/**', 'node_modules/**', 'build/**'];

// Unused-variable reporting that does not fight the codebase's idioms: a leading
// underscore means "required by a signature, deliberately unused", and caught
// errors are frequently ignored on purpose (`catch { /* keep looking */ }`).
const noUnused = [
  'error',
  { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
];

const shared = {
  'no-unused-vars': noUnused,
  // An await inside a loop is usually deliberate here (probing peers in turn,
  // draining a queue) and flagging it produces noise, not bugs.
  'no-await-in-loop': 'off',
  // Conditions that cannot do what they look like they do. These are the ones
  // that find real defects rather than opinions.
  'no-constant-binary-expression': 'error',
  'no-self-compare': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unreachable-loop': 'error',
  // Deliberately off, both of them, after seeing what they actually flagged
  // here. `no-promise-executor-return` fires on `new Promise((r) => setTimeout(r, ms))`,
  // which appears in nearly every test in the suite and is not a mistake in any
  // of them; `require-atomic-updates` reported `Date.now` and `hub.send` as
  // races, which is its well-known false-positive shape. A rule that is wrong
  // more often than it is right teaches people to run the linter with their eyes
  // closed, and then it catches nothing at all.
  'no-promise-executor-return': 'off',
  'require-atomic-updates': 'off',
  eqeqeq: ['error', 'smart'],
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-var': 'error',
  // A name that was never declared. Not a style opinion: in a module — every
  // file here is either strict CommonJS or ESM — reading one throws and writing
  // one throws, so every hit is code that cannot run. It was off, and two of
  // them shipped in the same release: a key returned from publicConfig() that
  // nothing had read, which made every config call throw and left Settings
  // showing seed defaults, and a leftover `poisoned` in ptt.js that threw before
  // push-to-talk could open the mic. Both were one word, and both were invisible
  // to a reader and to the test suite.
  'no-undef': 'error',
};

module.exports = [
  { ignores: IGNORED },

  // Main process, preload, tooling and tests: CommonJS on Node.
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: shared,
  },

  // The preload also touches the page it is injected into.
  {
    files: ['src/preload/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // Renderer: ESM and JSX, in a browser. Node never parses these — Vite does —
  // which is why they can use `import` under a CommonJS package type.
  {
    files: ['src/renderer/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: { 'react-hooks': reactHooks, react },
    rules: {
      ...shared,
      // ESLint's core has no idea that `<Sidebar />` uses `Sidebar`: JSX parses,
      // but nothing marks the identifier as read, so every component import in
      // the tree reads as dead. These two rules are the whole reason
      // eslint-plugin-react is here — not for its style opinions, which stay off.
      //
      // It was reaching us transitively until the lockfile was synced, at which
      // point 133 imports were suddenly "unused". A dependency you rely on but
      // do not declare is one `npm ci` away from being a surprise.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      // The two `eslint-disable-next-line react-hooks/exhaustive-deps` comments
      // already in the tree were written against a linter that did not exist.
      // Now it does, and they mean what they say.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Vite's config: ESM, at the root of a CommonJS package.
  {
    files: ['vite.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: shared,
  },
];
