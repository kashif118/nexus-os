import boundaries from 'eslint-plugin-boundaries'
import prettier from 'eslint-config-prettier'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'
import tseslint from 'typescript-eslint'

/**
 * Layering rules from `docs/ARCHITECTURE.md` §B.2 are enforced mechanically here
 * rather than by review. The element types mirror the folder structure in
 * `docs/PLATFORM.md` §F.
 *
 * The layering is the load-bearing part of the architecture: it is what keeps
 * Prisma out of the UI, authorization out of repositories, and React out of the
 * service layer. A violation is an error, never a warning.
 */

/** Allow an element type to import the given element types. */
const layer = (from, to) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: [].concat(to) } } } },
})

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
      'src/generated/**',
    ],
  },

  ...nextCoreWebVitals,
  ...nextTypeScript,
  ...tseslint.configs.recommended,

  {
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
      },
      'boundaries/include': ['src/**/*'],

      // Elements classify FOLDERS: which area of the system a file belongs to.
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app' },
        { type: 'module', pattern: 'src/modules/*', capture: ['module'] },
        { type: 'kernel', pattern: 'src/kernel' },
        { type: 'lib', pattern: 'src/lib' },
        { type: 'components', pattern: 'src/components' },
        { type: 'styles', pattern: 'src/styles' },
        { type: 'types', pattern: 'src/types' },
      ],

      // Files classify the LAYER a file occupies inside its element.
      'boundaries/files': [
        { category: 'transport', pattern: 'src/modules/*/{actions,queries}.ts' },
        { category: 'service', pattern: 'src/modules/*/service.ts' },
        { category: 'repository', pattern: 'src/modules/*/repository.ts' },
        { category: 'db', pattern: 'src/lib/db.ts' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // --- Folder-level reachability -------------------------------
            layer('app', ['app', 'module', 'components', 'kernel', 'lib', 'styles', 'types']),
            layer('module', ['module', 'components', 'kernel', 'lib', 'types']),
            layer('kernel', ['kernel', 'lib', 'types']),
            layer('lib', ['lib', 'kernel', 'types']),
            layer('components', ['components', 'lib', 'kernel', 'types']),
            layer('styles', 'styles'),
            layer('types', 'types'),

            // --- Layer-level refinements ---------------------------------
            // These are the rules that actually protect the architecture, so
            // they are expressed as explicit denials on top of the above.
            {
              from: { element: { type: 'app' } },
              disallow: {
                to: { file: { categories: { anyOf: ['service', 'repository', 'db'] } } },
              },
              message:
                'UI must call a module through its actions/queries, never its service, repository or the database client (docs/ARCHITECTURE.md §B.2).',
            },
            {
              from: { element: { type: 'components' } },
              disallow: { to: { element: { type: 'module' } } },
              message:
                'Shared components must stay presentational. Module-specific UI belongs in src/modules/<module>/components.',
            },
            {
              from: { file: { categories: 'transport' } },
              disallow: { to: { file: { categories: { anyOf: ['repository', 'db'] } } } },
              message:
                'Actions and queries call the service layer, which owns authorization and transactions (docs/ARCHITECTURE.md §B.2).',
            },
            {
              from: { file: { categories: 'service' } },
              disallow: { to: { file: { categories: 'db' } } },
              message:
                'Services reach the database through their repository, never the Prisma client directly.',
            },
            {
              from: { element: { types: { anyOf: ['app', 'components', 'lib', 'styles'] } } },
              disallow: { to: { file: { categories: 'db' } } },
              message:
                'Only repositories and the kernel may import the database client (docs/PLATFORM.md §H.3).',
            },
          ],
        },
      ],

      // Prisma is reachable only through src/lib/db.ts, which owns the
      // org-scoping client extension that makes tenant isolation structural.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Import the org-scoped client from "@/lib/db" instead. Direct Prisma access bypasses tenant isolation (docs/PLATFORM.md §H.3).',
            },
          ],
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // The single place allowed to import Prisma directly.
  {
    files: ['src/lib/db.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // process.env is read only by the validated config kernel (docs/OPERATIONS.md §P.4).
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/kernel/config/env.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration from "@/kernel/config/env" instead of process.env (docs/OPERATIONS.md §P.4).',
        },
      ],
    },
  },

  // Tooling, tests and config files sit outside the application layering.
  {
    files: ['scripts/**/*.ts', 'e2e/**/*.ts', '**/*.config.{ts,mts,mjs}', '**/*.test.ts'],
    rules: {
      'boundaries/dependencies': 'off',
      'no-restricted-properties': 'off',
      'no-console': 'off',
    },
  },

  prettier,
)
