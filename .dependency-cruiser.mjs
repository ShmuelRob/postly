// Module boundary rules, enforced by `npm run lint:boundaries` and by
// src/modules/boundaries.test.ts. The rules are described in src/modules/README.md.

// Vendor SDKs per owning module. A vendor package may be imported only from
// src/modules/<owner>/adapters/. Add a package here when an adapter starts using it.
const vendorPackages = {
  messaging: ['twilio', '360dialog', '@360dialog/.+'],
  publishing: ['zernio', '@zernio/.+', 'social-media-api', '@ayrshare/.+'],
  'model-layer': [
    '@google/genai',
    '@google/generative-ai',
    '@google-cloud/vertexai',
    '@google-cloud/aiplatform',
    '@google-cloud/speech',
    'google-auth-library',
  ],
  design: ['playwright', 'playwright-core', '@playwright/.+', 'sharp', '@img/.+'],
  // billing: the payment vendor is still open (technical-design.md); add it here.
};

// Database drivers and connection-level imports. Only src/db/ may open a
// connection; everything else goes through the business-context helper that
// src/db/index.ts exports.
const databaseDrivers = [
  'pg',
  'postgres',
  '@electric-sql/pglite',
  'drizzle-orm/node-postgres',
  'pg-boss',
  'drizzle-orm/postgres-js',
  'drizzle-orm/pglite',
  'drizzle-orm/neon-serverless',
];

// Matches a bare specifier when unresolved, or its node_modules path when resolved.
const packagePattern = (names) => `(^|(^|/)node_modules/)(${names.join('|')})(/|$)`;

const vendorRules = Object.entries(vendorPackages).map(([owner, names]) => ({
  name: 'vendor-outside-adapter',
  comment: `Vendor SDKs for ${owner} are imported only in src/modules/${owner}/adapters/.`,
  severity: 'error',
  from: { pathNot: `^src/modules/${owner}/adapters/` },
  to: { path: packagePattern(names) },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    ...vendorRules,
    {
      name: 'module-internals',
      comment: 'Another module is imported only through its index.ts.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/.+',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'module-internals',
      comment: 'Code outside src/modules/ imports a module only through its index.ts.',
      severity: 'error',
      from: { pathNot: '^src/modules/' },
      to: {
        path: '^src/modules/[^/]+/.+',
        pathNot: '^src/modules/[^/]+/index\\.ts$',
      },
    },
    {
      name: 'no-playground',
      comment: 'The local playground (playground/) is dev-only; product code never imports it.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^playground/' },
    },
    {
      name: 'db-driver-outside-db',
      comment: 'Only src/db/ opens database connections (and test/db/, which starts the test database).',
      severity: 'error',
      from: { pathNot: ['^src/db/', '^test/db/'] },
      to: { path: packagePattern(databaseDrivers) },
    },
    {
      name: 'db-internals',
      comment:
        'Outside src/db/ (and test/db/, which migrates the test database), import only src/db/index.ts (the business-context helper) and src/db/schema.ts.',
      severity: 'error',
      from: { pathNot: ['^src/db/', '^test/db/'] },
      to: {
        path: '^src/db/',
        pathNot: '^src/db/(index|schema)\\.ts$',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // TypeScript 7 has no JS compiler API, so .ts files are parsed with swc.
    parser: 'swc',
  },
};
