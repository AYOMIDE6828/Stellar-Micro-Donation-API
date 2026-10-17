'use strict';

/**
 * ESLint rule: consistent-exports
 *
 * Enforces consistent module export patterns per module type:
 * - Services/Classes: direct export (module.exports = ClassName)
 * - Utilities: named exports (module.exports = { func1, func2, ... })
 * - Routes: direct router export
 * - Migrations: special format (exports.up, exports.down)
 *
 * See docs/EXPORT_CONVENTIONS.md for full guidelines.
 */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce consistent export patterns by module type',
      url: 'docs/EXPORT_CONVENTIONS.md',
    },
    messages: {
      inconsistentService:
        'Service modules should export the class/service directly, not as an object literal. ' +
        'Change: module.exports = Class; See docs/EXPORT_CONVENTIONS.md',
      inconsistentUtil:
        'Utility modules should export named functions in an object. ' +
        'Change: module.exports = { func1, func2, ... }; See docs/EXPORT_CONVENTIONS.md',
      inconsistentRoute:
        'Route modules should export a router directly. ' +
        'Change: module.exports = router; See docs/EXPORT_CONVENTIONS.md',
      inconsistentMigration:
        'Migration modules should use named exports (exports.up, exports.down). ' +
        'Change: exports.up = ...; exports.down = ...; See docs/EXPORT_CONVENTIONS.md',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename();

    const isServiceModule = /src\/services\//.test(filename);
    const isUtilityModule = /src\/utils\//.test(filename);
    const isRouteModule = /src\/routes\//.test(filename);
    const isMigrationModule = /src\/migrations\//.test(filename);

    let moduleExportNode = null;
    let exportsAssignments = new Set();

    return {
      AssignmentExpression(node) {
        if (
          node.left.type === 'MemberExpression' &&
          node.left.object.name === 'module' &&
          node.left.property.name === 'exports'
        ) {
          moduleExportNode = node;
        }

        if (
          node.left.type === 'MemberExpression' &&
          node.left.object.name === 'exports'
        ) {
          exportsAssignments.add(node.left.property.name);
        }
      },

      'Program:exit'() {
        // Skip this rule for test files
        if (/\.test\.js$/.test(filename)) {
          return;
        }

        // Check service modules
        if (isServiceModule) {
          if (moduleExportNode) {
            const exportValue = moduleExportNode.right;
            if (exportValue.type === 'ObjectExpression') {
              context.report({
                node: moduleExportNode,
                messageId: 'inconsistentService',
              });
            }
          }
        }

        // Check utility modules
        if (isUtilityModule) {
          if (moduleExportNode) {
            const exportValue = moduleExportNode.right;
            if (exportValue.type !== 'ObjectExpression') {
              context.report({
                node: moduleExportNode,
                messageId: 'inconsistentUtil',
              });
            }
          }
        }

        // Check route modules
        if (isRouteModule) {
          if (moduleExportNode) {
            const exportValue = moduleExportNode.right;
            if (exportValue.type === 'ObjectExpression') {
              context.report({
                node: moduleExportNode,
                messageId: 'inconsistentRoute',
              });
            }
          }
        }

        // Check migration modules
        if (isMigrationModule) {
          if (moduleExportNode) {
            context.report({
              node: moduleExportNode,
              messageId: 'inconsistentMigration',
            });
          }
        }
      },
    };
  },
};
