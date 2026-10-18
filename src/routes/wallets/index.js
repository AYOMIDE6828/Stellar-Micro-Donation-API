/**
 * Wallet Routes - Composition Layer
 *
 * RESPONSIBILITY: Mount decomposed wallet sub-routers (issue #1212)
 * OWNER: Backend Team
 * DEPENDENCIES: Wallet sub-routers in this directory
 *
 * This file now serves as a thin composition layer that mounts focused
 * sub-routers, each handling specific wallet operations:
 * - crud.js: CRUD + bulk operations
 * - metadata.js: Wallet metadata (get, update, delete)
 * - balance-history.js: Balance and transaction history
 * - home-domain.js: Home domain management
 * - inflation.js: Inflation destination
 * - sponsorship.js: Account sponsorship
 * - trustlines.js: Trustline management
 * - data-entries.js: Account data
 * - merge.js: Account merging
 * - limits-config.js: Wallet limits and config
 *
 * See docs/WALLET_ROUTES_COMPOSITION.md for architecture details.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parseCsvSync } = require('csv-parse/sync');
const { checkPermission, requireAdmin } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../utils/permissions');
const { buildErrorResponse } = require('../../utils/validationErrorFormatter');
const { toWalletResponse } = require('../../utils/responseSanitizer');
const { payloadSizeLimiter, ENDPOINT_LIMITS } = require('../../middleware/payloadSizeLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const { parseCursorPaginationQuery } = require('../../utils/pagination');
const { bulkImportRateLimiter, friendbotRateLimiter } = require('../../middleware/rateLimiter');
const { cacheMiddleware } = require('../../middleware/caching');
const Database = require('../../utils/database');
const Wallet = require('../../models/wallet');
const WalletService = require('../../services/WalletService');
const AuditLogService = require('../../services/AuditLogService');
const requireApiKey = require('../../middleware/apiKey');
const { getStellarService } = require('../../config/stellar');
const { walletCreateSchema, walletIdSchema } = require('./helpers');

const walletService = new WalletService(getStellarService());

// ─── Helper Functions ────────────────────────────────────────────────────

function getBulkMaxBytes() {
  const parsed = parseInt(process.env.BULK_IMPORT_MAX_SIZE_BYTES || '1048576', 10);
  return isNaN(parsed) ? 1048576 : parsed;
}

function getBulkMaxRows() {
  const parsed = parseInt(process.env.BULK_IMPORT_MAX_ROWS || '1000', 10);
  return isNaN(parsed) ? 1000 : parsed;
}

// ─── POST /wallets ───────────────────────────────────────────────────────
/**
 * Create wallet metadata
 * Body: { address: string (required), label?: string, ownerName?: string, sponsored?: boolean }
 * Requires wallets:create permission
 */
router.post(
  '/',
  payloadSizeLimiter(ENDPOINT_LIMITS.wallet),
  checkPermission(PERMISSIONS.WALLETS_CREATE),
  walletCreateSchema,
  asyncHandler(async (req, res, next) => {
    try {
      const { address, label, ownerName, sponsored } = req.body;

      if (!address) {
        return res.status(400).json(
          buildErrorResponse([{ code: 'MISSING_ADDRESS', receivedValue: address }])
        );
      }

      // Validate Stellar public key format using the Stellar SDK
      const StellarSdk = require('stellar-sdk');
      if (!StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
        const { formatError } = require('../../utils/errors');
        return res.status(400).json(formatError('INVALID_PUBLIC_KEY', 'Invalid Stellar public key format', req.id));
      }

      // Create wallet metadata
      const wallet = await walletService.createWallet({
        address,
        label,
        ownerName,
        sponsored: sponsored || false
      });

      await AuditLogService.log({
        category: AuditLogService.CATEGORY.WALLET_OPERATION,
        action: AuditLogService.ACTION.WALLET_CREATED,
        severity: AuditLogService.SEVERITY.MEDIUM,
        result: 'SUCCESS',
        userId: req.user && req.user.id,
        requestId: req.id,
        ipAddress: req.ip,
        resource: `/wallets/${wallet.id}`,
        details: { address, funded: wallet.funded }
      });

      res.status(201).json({
        success: true,
        data: toWalletResponse(wallet)
      });
    } catch (error) {
      next(error);
    }
  })
);

// ─── GET /wallets ────────────────────────────────────────────────────────
/**
 * List wallets with cursor-based pagination
 * Query params:
 *   - limit: page size (default 20, max 100)
 *   - cursor: opaque pagination cursor
 *   - direction: 'next' | 'prev' (default 'next')
 *   - sort: 'id:asc'|'id:desc'|'createdAt:asc'|'createdAt:desc'|'publicKey:asc'|'publicKey:desc'
 */
router.get(
  '/',
  checkPermission(PERMISSIONS.WALLETS_READ),
  cacheMiddleware('wallet', 'private'),
  (req, res, next) => {
    try {
      const VALID_SORT = ['id:asc', 'id:desc', 'createdAt:asc', 'createdAt:desc', 'publicKey:asc', 'publicKey:desc'];
      const sort = req.query.sort || 'id:asc';
      if (!VALID_SORT.includes(sort)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_SORT',
            message: `Invalid sort value. Valid options: ${VALID_SORT.join(', ')}`,
          },
        });
      }

      const pagination = parseCursorPaginationQuery(req.query);
      const result = walletService.getPaginatedWallets(pagination, sort);

      res.setHeader('X-Total-Count', String(result.totalCount));

      res.json({
        success: true,
        data: result.data.map(toWalletResponse),
        count: result.data.length,
        total: result.totalCount,
        nextCursor: result.meta.next_cursor,
        meta: result.meta
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /wallets/bulk-import ───────────────────────────────────────────
/**
 * Bulk import wallets from CSV file
 * Admin only, rate limited
 * File format: CSV with headers (address, label?, ownerName?)
 */
router.post(
  '/bulk-import',
  requireAdmin(),
  bulkImportRateLimiter,
  (req, res, next) => {
    const maxBytes = getBulkMaxBytes();
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxBytes },
    });
    upload.single('file')(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        const maxMB = (maxBytes / (1024 * 1024)).toFixed(2);
        return res.status(413).json({
          success: false,
          error: {
            code: 'FILE_TOO_LARGE',
            message: `File exceeds the maximum allowed size of ${maxMB} MB (${maxBytes} bytes).`,
            details: { max_size_bytes: maxBytes },
          },
        });
      }
      if (err) return next(err);
      next();
    });
  },
  asyncHandler(async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_FILE', message: 'A file upload is required (field: "file")' },
        });
      }

/**
  * Response sanitizer middleware applied to all wallet endpoints.
  * Ensures internal/sensitive fields are stripped from all wallet responses.
  */
function walletResponseSanitizer(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (body && typeof body === 'object') {
      if (body.data) {
        if (Array.isArray(body.data)) {
          body.data = body.data.map(item => (item && typeof item === 'object' && (item.id || item.publicKey || item.address) ? toWalletResponse(item) : item));
        } else if (typeof body.data === 'object') {
          if (Array.isArray(body.data.wallets)) {
            body.data.wallets = body.data.wallets.map(item => (item && typeof item === 'object' ? toWalletResponse(item) : item));
          } else if (body.data.id || body.data.publicKey || body.data.address) {
            body.data = toWalletResponse(body.data);
          }
        }
      }
    }
    return originalJson(body);
  };
  next();
}

// Apply response sanitizer middleware to all wallet endpoints
router.use(walletResponseSanitizer);

// Mount decomposed sub-routers
const crudRouter = require('./crud');
const metadataRouter = require('./metadata');
const balanceHistoryRouter = require('./balance-history');
const homeDomainRouter = require('./home-domain');
const inflationRouter = require('./inflation');
const sponsorshipRouter = require('./sponsorship');
const trustlinesRouter = require('./trustlines');
const dataEntriesRouter = require('./data-entries');
const mergeRouter = require('./merge');
const limitsConfigRouter = require('./limits-config');

// Mount all routes (sub-routers handle their own paths)
router.use('/', crudRouter);
router.use('/', metadataRouter);
router.use('/', balanceHistoryRouter);
router.use('/', homeDomainRouter);
router.use('/', inflationRouter);
router.use('/', sponsorshipRouter);
router.use('/', trustlinesRouter);
router.use('/', dataEntriesRouter);
router.use('/', mergeRouter);
router.use('/', limitsConfigRouter);

module.exports = router;
module.exports.ALLOWED_WALLET_FIELDS = ALLOWED_WALLET_FIELDS;
module.exports.walletResponseSanitizer = walletResponseSanitizer;

