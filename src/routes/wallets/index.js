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
 * @openapi
 * /wallets:
 *   post:
 *     summary: Create wallet metadata
 *     description: Registers metadata for a Stellar wallet address. Requires the `wallets:create` permission.
 *     tags:
 *       - Wallets
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - address
 *             properties:
 *               address:
 *                 type: string
 *                 description: Valid Stellar Ed25519 public key
 *                 example: GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
 *               label:
 *                 type: string
 *                 example: Main wallet
 *               ownerName:
 *                 type: string
 *                 example: Jane Doe
 *               sponsored:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Wallet created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Wallet'
 *       400:
 *         description: Missing or invalid address
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
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
 * @openapi
 * /wallets:
 *   get:
 *     summary: List wallets
 *     description: Returns wallets using cursor-based pagination. Requires the `wallets:read` permission.
 *     tags:
 *       - Wallets
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Page size
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Opaque pagination cursor
 *       - in: query
 *         name: direction
 *         schema:
 *           type: string
 *           enum: [next, prev]
 *           default: next
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum:
 *             - id:asc
 *             - id:desc
 *             - createdAt:asc
 *             - createdAt:desc
 *             - publicKey:asc
 *             - publicKey:desc
 *           default: id:asc
 *     responses:
 *       200:
 *         description: Paginated list of wallets
 *         headers:
 *           X-Total-Count:
 *             schema:
 *               type: integer
 *             description: Total number of wallets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Wallet'
 *                 count:
 *                   type: integer
 *                 total:
 *                   type: integer
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *                 meta:
 *                   type: object
 *       400:
 *         description: Invalid sort or pagination parameters
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
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
 * @openapi
 * /wallets/bulk-import:
 *   post:
 *     summary: Bulk import wallets from CSV
 *     description: Imports wallets from a CSV file. Admin only and rate limited. CSV must include an `address` header column; optional `label` and `ownerName` columns are supported.
 *     tags:
 *       - Wallets
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Import summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     imported:
 *                       type: integer
 *                     skipped:
 *                       type: integer
 *                     failed:
 *                       type: integer
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           row:
 *                             type: integer
 *                           address:
 *                             type: string
 *                           reason:
 *                             type: string
 *       400:
 *         description: Missing file, parse error, empty file, or invalid header
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (admin only)
 *       413:
 *         description: File too large
 *       422:
 *         description: Row limit exceeded
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
 * @openapi
 * /wallets/{id}/fund:
 *   post:
 *     summary: Fund a wallet via Stellar Friendbot
 *     description: Funds a wallet on testnet using Friendbot. Rate limited to 5 requests per minute per API key. Requires the `wallets:update` permission.
 *     tags:
 *       - Wallets
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Wallet ID
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Fund again even if the wallet already has a balance
 *     responses:
 *       200:
 *         description: Wallet funded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     walletId:
 *                       type: string
 *                     publicKey:
 *                       type: string
 *                     funded:
 *                       type: boolean
 *                     transactionHash:
 *                       type: string
 *       400:
 *         description: Wallet already funded (use force=true)
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden or friendbot unavailable in production
 *       404:
 *         description: Wallet not found
 *       429:
 *         description: Rate limit exceeded
 */
router.post(
  '/:id/fund',
  requireApiKey,
  checkPermission(PERMISSIONS.WALLETS_UPDATE),
  walletIdSchema,
  friendbotRateLimiter,
  asyncHandler(async (req, res, next) => {
    try {
      const { id } = req.params;
      const force = req.query.force === 'true';

      const wallet = await Database.get(
        'SELECT id, publicKey FROM users WHERE id = ?',
        [id]
      );
      if (!wallet) {
        return res.status(404).json({ success: false, error: 'Wallet not found' });
      }

      if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
          success: false,
          error: 'Friendbot funding is only available on testnet'
        });
      }

      const stellarService = getStellarService();
      try {
        const account = await stellarService.getAccount(wallet.publicKey);
        if (account.balances && account.balances.length > 0) {
          if (!force) {
            return res.status(400).json({
              success: false,
              error: 'Wallet is already funded. Use ?force=true to fund again'
            });
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

