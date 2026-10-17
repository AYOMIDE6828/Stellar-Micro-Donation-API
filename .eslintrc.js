const hasSecurityPlugin = (() => {
  try {
    require.resolve('eslint-plugin-security');
    return true;
  } catch (error) {
    return false;
  }
})();

/**
 * Files grandfathered from the max-lines rule while they are being decomposed.
 * As decomposition PRs land, remove entries from this list one by one.
 * Issue tracking: #1211 (split MockStellarService), #1212 (decompose DonationService),
 * #1213 (decompose wallet route), #1214 (decompose donation route)
 *
 * Issue #1394: This array was previously referenced in the overrides block but
 * never declared, causing a ReferenceError on config load and breaking all lint
 * and SAST CI jobs. Declared here to fix that.
 */
const GRANDFATHERED_LARGE_FILES = [
  'src/services/MockStellarService.js',
  'src/services/DonationService.js',
  'src/services/RecurringDonationScheduler.js',
  'src/services/TransactionReconciliationService.js',
  'src/services/WebhookService.js',
  'src/services/AuditLogExportService.js',
  'src/services/StatsService.js',
  'src/services/LeaderboardStatsService.js',
  'src/services/ApiKeyUsageService.js',
  'src/routes/stream.js',
  'src/routes/transactions/core.js',
  'src/routes/campaigns.js',
  'src/routes/apiKeys.js',
  'src/routes/assets.js',
  'src/bootstrap/routes.js',
  'src/bootstrap/server.js',
  'src/utils/database.js',
  'src/utils/tracing.js',
  'src/middleware/rbac.js',
  'src/middleware/rateLimiter.js',
  'tests/donations/donation-routes.test.js',
  'tests/donations/recurring-donation-scheduling-flexi.test.js',
  'tests/donations/donation-matching-program.test.js',
  'tests/misc/input-sanitization-for-xss-and-injection-preve.test.js',
  'tests/misc/comprehensive-input-validation-error-mes.test.js',
  'tests/admin/api-key-scoping-finegrained-permiss.test.js',
  'tests/admin/twofactor-authentication-for-admin-operations.test.js',
  'tests/security/rbac-authorization-matrix.test.js',
  'tests/transactions/stellar-transaction-sequence-number-management.test.js',
  'tests/tracing/distributed-tracing-opentelemetry.test.js',
];

module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true,
  },
  extends: ['eslint:recommended'],
  plugins: ['no-secrets', ...(hasSecurityPlugin ? ['security'] : []), 'local'],
  parserOptions: {
    ecmaVersion: 2022,
  },
  rules: {
    // Unused vars: flag dead variables/imports, but allow intentionally-unused
    // function arguments (interface/abstract stubs, middleware signatures) and
    // caught errors. Prefix with `_` to explicitly mark a local as unused.
    'no-unused-vars': ['error', {
      args: 'none',
      caughtErrors: 'none',
      ignoreRestSiblings: true,
      varsIgnorePattern: '^_',
    }],

    // File length budget: encourage files under 1000 lines (warn) to prevent
    // unbounded growth without blocking all work. Grandfathered large files
    // are exempt while they're being decomposed. New files must stay under budget.
    'max-lines': ['warn', {
      max: 1000,
      skipBlankLines: true,
      skipComments: true,
    }],

    // Security rules. no-secrets flags high-entropy strings; the patterns below are
    // verified non-secrets (doc paths, URLs, SQL/identifier names, env-var doc
    // strings, OpenAPI examples, the standard RFC 4648 base32 alphabet). Real
    // random tokens/keys do not match these and are still flagged.
    'no-secrets/no-secrets': ['error', {
      ignoreContent: [
        '\\.md',                                 // documentation file paths
        'https?://',                             // URLs
        'idx_recovery_guardians',                // SQL index names
        'wal_checkpoint',                        // SQLite pragma
        'buildAndSubmitFeeBumpTransaction',      // method identifier
        'INVALID_WEBHOOK_SIGNATURE',             // error-code constant
        'ENCRYPTION_KEY',                        // env-var doc string
        'REQUIRE_IDEMPOTENCY_KEY',               // env-var doc string
        'ACCESS_LOG_INCLUDE_HEALTH',             // env-var doc string
        'snapshotAt=',                           // example query string
        'stellar_public_key',                    // example placeholder
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',      // RFC 4648 base32 alphabet
        '^eyJ',                                  // example JWT (OpenAPI docs)
        '014_webhook_tls_skip_verify',           // migration name
        'obj<<',                                 // embedded PDF template
      ],
    }],
    ...(hasSecurityPlugin ? {
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-unsafe-regex': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-child-process': 'warn',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-non-literal-require': 'warn',
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-pseudoRandomBytes': 'error',
    } : {}),

    // Code quality rules that affect security
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-console': 'off',
    'local/require-async-handler': 'error',
    'local/no-floating-promises': 'error',
    'local/consistent-exports': 'error',
  },
  overrides: [
    {
      // Grandfathered large files: exempt from max-lines while being decomposed.
      // See the GRANDFATHERED_LARGE_FILES declaration at the top of this file.
      files: GRANDFATHERED_LARGE_FILES,
      rules: {
        'max-lines': 'off',
      },
    },
    {
      // Enforce structured logging in all service source files. Operational/CLI
      // scripts (migrations, the env-validation boot check) print to the console
      // by design and are exempt.
      files: ['src/**/*.js'],
      excludedFiles: [
        'src/scripts/**/*.js',
        'src/migrations/**/*.js',
        // Config loads at boot before the logger and the logger itself depends on
        // config (src/utils/log.js requires ../config), so config must use console.
        'src/config/**/*.js',
        'src/utils/log.js',
        'src/utils/migrationRunner.js',
        'src/utils/startupChecks.js',
      ],
      rules: {
        'no-console': 'error',
      },
    },
    {
      files: [
        'src/services/**/*.js',
        'src/jobs/**/*.js',
        'src/workers/**/*.js',
        'src/utils/**/*.js',
        'src/middleware/**/*.js',
        'src/routes/**/*.js',
      ],
      excludedFiles: [
        'src/services/MockStellarService.js',
      ],
      rules: {
        'local/no-bare-timers': 'error',
      },
    },
  ],
  ignorePatterns: [
    'node_modules/',
    'data/',
    'logs/',
    'coverage/',
  ],
};
