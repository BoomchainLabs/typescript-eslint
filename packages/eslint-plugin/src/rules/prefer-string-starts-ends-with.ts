import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

import { RegExpParser } from '@eslint-community/regexpp';
import { AST_NODE_TYPES } from '@typescript-eslint/utils';

import {
  createRule,
  getParserServices,
  getPropertyName,
  getStaticValue,
  getTypeName,
  isNotClosingParenToken,
  isStaticMemberAccessOfValue,
  nullThrows,
  NullThrowsReasons,
  skipChainExpression,
} from '../util';

const EQ_OPERATORS = /^[=!]=/;
const regexpp = new RegExpParser();

type AllowedSingleElementEquality = 'always' | 'never';

export type Options = [
  {
    allowSingleElementEquality?: AllowedSingleElementEquality;
  },
];

export type MessageIds = 'preferEndsWith' | 'preferStartsWith';

export default createRule<Options, MessageIds>({
  name: 'prefer-string-starts-ends-with',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce using `String#startsWith` and `String#endsWith` over other equivalent methods of checking substrings',
      recommended: 'stylistic',
      requiresTypeChecking: true,
    },
    fixable: 'code',
    messages: {
      preferEndsWith: "Use the 'String#endsWith' method instead.",
      preferStartsWith: "Use 'String#startsWith' method instead.",
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowSingleElementEquality: {
            type: 'string',
            description:
              'Whether to allow equality checks against the first or last element of a string.',
            enum: ['always', 'never'],
          },
        },
      },
    ],
  },

  defaultOptions: [{ allowSingleElementEquality: 'never' }],

  create(context, [{ allowSingleElementEquality }]) {
    const globalScope = context.sourceCode.getScope(context.sourceCode.ast);

    const services = getParserServices(context);
    const checker = services.program.getTypeChecker();

    /**
     * Check if a given node is a string.
     * @param node The node to check.
     */
    function isStringType(node: TSESTree.Expression): boolean {
      const objectType = services.getTypeAtLocation(node);
      return getTypeName(checker, objectType) === 'string';
    }

    /**
     * Check if a given node is a `Literal` node that is null.
     * @param node The node to check.
     */
    function isNull(node: TSESTree.Node): node is TSESTree.Literal {
      const evaluated = getStaticValue(node, globalScope);
      return evaluated != null && evaluated.value == null;
    }

    /**
     * Check if a given node is a `Literal` node that is a given value.
     * @param node The node to check.
     * @param value The expected value of the `Literal` node.
     */
    function isNumber(
      node: TSESTree.Node,
      value: number,
    ): node is TSESTree.Literal {
      const evaluated = getStaticValue(node, globalScope);
      return evaluated != null && evaluated.value === value;
    }

    /**
     * Check if a given node is a `Literal` node that is a character.
     * @param node The node to check.
     */
    function isCharacter(node: TSESTree.Node): node is TSESTree.Literal {
      const evaluated = getStaticValue(node, globalScope);
      return (
        evaluated != null &&
        typeof evaluated.value === 'string' &&
        // checks if the string is a character long
        evaluated.value[0] === evaluated.value
      );
    }

    /**
     * Check if a given node is `==`, `===`, `!=`, or `!==`.
     * @param node The node to check.
     */
    function isEqualityComparison(
      node: TSESTree.Node,
    ): node is TSESTree.BinaryExpression {
      return (
        node.type === AST_NODE_TYPES.BinaryExpression &&
        EQ_OPERATORS.test(node.operator)
      );
    }

    /**
     * Check if two given nodes are the same meaning.
     * @param node1 A node to compare.
     * @param node2 Another node to compare.
     */
    function isSameTokens(node1: TSESTree.Node, node2: TSESTree.Node): boolean {
      const tokens1 = context.sourceCode.getTokens(node1);
      const tokens2 = context.sourceCode.getTokens(node2);

      if (tokens1.length !== tokens2.length) {
        return false;
      }

      for (let i = 0; i < tokens1.length; ++i) {
        const token1 = tokens1[i];
        const token2 = tokens2[i];

        if (token1.type !== token2.type || token1.value !== token2.value) {
          return false;
        }
      }

      return true;
    }

    /**
     * Check if a given node is the expression of the length of a string.
     *
     * - If `length` property access of `expectedObjectNode`, it's `true`.
     *   E.g., `foo` → `foo.length` / `"foo"` → `"foo".length`
     * - If `expectedObjectNode` is a string literal, `node` can be a number.
     *   E.g., `"foo"` → `3`
     *
     * @param node The node to check.
     * @param expectedObjectNode The node which is expected as the receiver of `length` property.
     */
    function isLengthExpression(
      node: TSESTree.Node,
      expectedObjectNode: TSESTree.Node,
    ): boolean {
      if (node.type === AST_NODE_TYPES.MemberExpression) {
        return (
          getPropertyName(node, globalScope) === 'length' &&
          isSameTokens(node.object, expectedObjectNode)
        );
      }

      const evaluatedLength = getStaticValue(node, globalScope);
      const evaluatedString = getStaticValue(expectedObjectNode, globalScope);
      return (
        evaluatedLength != null &&
        evaluatedString != null &&
        typeof evaluatedLength.value === 'number' &&
        typeof evaluatedString.value === 'string' &&
        evaluatedLength.value === evaluatedString.value.length
      );
    }

    /**
     * Returns true if `node` is `-substring.length` or
     * `parentString.length - substring.length`
     */
    function isLengthAheadOfEnd(
      node: TSESTree.Node,
      substring: TSESTree.Node,
      parentString: TSESTree.Node,
    ): boolean {
      return (
        (node.type === AST_NODE_TYPES.UnaryExpression &&
          node.operator === '-' &&
          isLengthExpression(node.argument, substring)) ||
        (node.type === AST_NODE_TYPES.BinaryExpression &&
          node.operator === '-' &&
          isLengthExpression(node.left, parentString) &&
          isLengthExpression(node.right, substring))
      );
    }

    /**
     * Check if a given node is the expression of the last index.
     *
     * E.g. `foo.length - 1`
     *
     * @param node The node to check.
     * @param expectedObjectNode The node which is expected as the receiver of `length` property.
     */
    function isLastIndexExpression(
      node: TSESTree.Node,
      expectedObjectNode: TSESTree.Node,
    ): boolean {
      return (
        node.type === AST_NODE_TYPES.BinaryExpression &&
        node.operator === '-' &&
        isLengthExpression(node.left, expectedObjectNode) &&
        isNumber(node.right, 1)
      );
    }

    /**
     * Get the range of the property of a given `MemberExpression` node.
     *
     * - `obj[foo]` → the range of `[foo]`
     * - `obf.foo` → the range of `.foo`
     * - `(obj).foo` → the range of `.foo`
     *
     * @param node The member expression node to get.
     */
    function getPropertyRange(
      node: TSESTree.MemberExpression,
    ): [number, number] {
      const dotOrOpenBracket = nullThrows(
        context.sourceCode.getTokenAfter(node.object, isNotClosingParenToken),
        NullThrowsReasons.MissingToken('closing parenthesis', 'member'),
      );
      return [dotOrOpenBracket.range[0], node.range[1]];
    }

    /**
     * Parse a given `RegExp` pattern to that string if it's a static string.
     * @param pattern The RegExp pattern text to parse.
     * @param unicode Whether the RegExp is unicode.
     */
    function parseRegExpText(pattern: string, unicode: boolean): string | null {
      // Parse it.
      const ast = regexpp.parsePattern(pattern, undefined, undefined, {
        unicode,
      });
      if (ast.alternatives.length !== 1) {
        return null;
      }

      // Drop `^`/`$` assertion.
      const chars = ast.alternatives[0].elements;
      const first = chars[0];
      if (first.type === 'Assertion' && first.kind === 'start') {
        chars.shift();
      } else {
        chars.pop();
      }

      // Check if it can determine a unique string.
      if (!chars.every(c => c.type === 'Character')) {
        return null;
      }

      // To string.
      return String.fromCodePoint(...chars.map(c => c.value));
    }

    /**
     * Parse a given node if it's a `RegExp` instance.
     * @param node The node to parse.
     */
    function parseRegExp(
      node: TSESTree.Node,
    ): { isEndsWith: boolean; isStartsWith: boolean; text: string } | null {
      const evaluated = getStaticValue(node, globalScope);
      if (evaluated == null || !(evaluated.value instanceof RegExp)) {
        return null;
      }

      const { flags, source } = evaluated.value;
      const isStartsWith = source.startsWith('^');
      const isEndsWith = source.endsWith('$');
      if (
        isStartsWith === isEndsWith ||
        flags.includes('i') ||
        flags.includes('m')
      ) {
        return null;
      }

      const text = parseRegExpText(source, flags.includes('u'));
      if (text == null) {
        return null;
      }

      return { isEndsWith, isStartsWith, text };
    }

    function getLeftNode(
      init: TSESTree.Expression | TSESTree.PrivateIdentifier,
    ): TSESTree.MemberExpression {
      const node = skipChainExpression(init);
      const leftNode =
        node.type === AST_NODE_TYPES.CallExpression ? node.callee : node;

      if (leftNode.type !== AST_NODE_TYPES.MemberExpression) {
        throw new Error(`Expected a MemberExpression, got ${leftNode.type}`);
      }

      return leftNode;
    }

    /**
     * Fix code with using the right operand as the search string.
     * For example: `foo.slice(0, 3) === 'bar'` → `foo.startsWith('bar')`
     * @param fixer The rule fixer.
     * @param node The node which was reported.
     * @param kind The kind of the report.
     * @param isNegative The flag to fix to negative condition.
     */
    function* fixWithRightOperand(
      fixer: TSESLint.RuleFixer,
      node: TSESTree.BinaryExpression,
      kind: 'end' | 'start',
      isNegative: boolean,
      isOptional: boolean,
    ): IterableIterator<TSESLint.RuleFix> {
      // left is CallExpression or MemberExpression.
      const leftNode = getLeftNode(node.left);
      const propertyRange = getPropertyRange(leftNode);

      if (isNegative) {
        yield fixer.insertTextBefore(node, '!');
      }
      yield fixer.replaceTextRange(
        [propertyRange[0], node.right.range[0]],
        `${isOptional ? '?.' : '.'}${kind}sWith(`,
      );
      yield fixer.replaceTextRange([node.right.range[1], node.range[1]], ')');
    }

    /**
     * Fix code with using the first argument as the search string.
     * For example: `foo.indexOf('bar') === 0` → `foo.startsWith('bar')`
     * @param fixer The rule fixer.
     * @param node The node which was reported.
     * @param kind The kind of the report.
     * @param negative The flag to fix to negative condition.
     */
    function* fixWithArgument(
      fixer: TSESLint.RuleFixer,
      node: TSESTree.BinaryExpression,
      callNode: TSESTree.CallExpression,
      calleeNode: TSESTree.MemberExpression,
      kind: 'end' | 'start',
      negative: boolean,
      isOptional: boolean,
    ): IterableIterator<TSESLint.RuleFix> {
      if (negative) {
        yield fixer.insertTextBefore(node, '!');
      }
      yield fixer.replaceTextRange(
        getPropertyRange(calleeNode),
        `${isOptional ? '?.' : '.'}${kind}sWith`,
      );
      yield fixer.removeRange([callNode.range[1], node.range[1]]);
    }

    function getParent(node: TSESTree.Node): TSESTree.Node {
      return nullThrows(
        node.parent?.type === AST_NODE_TYPES.ChainExpression
          ? node.parent.parent
          : node.parent,
        NullThrowsReasons.MissingParent,
      );
    }

    return {
      // foo[0] === "a"
      // foo.charAt(0) === "a"
      // foo[foo.length - 1] === "a"
      // foo.charAt(foo.length - 1) === "a"
      [[
        'BinaryExpression > MemberExpression.left[computed=true]',
        'BinaryExpression > CallExpression.left > MemberExpression.callee[property.name="charAt"][computed=false]',
        'BinaryExpression > ChainExpression.left > MemberExpression[computed=true]',
        'BinaryExpression > ChainExpression.left > CallExpression > MemberExpression.callee[property.name="charAt"][computed=false]',
      ].join(', ')](node: TSESTree.MemberExpression): void {
        let parentNode = getParent(node);

        let indexNode: TSESTree.Node | null = null;
        if (parentNode.type === AST_NODE_TYPES.CallExpression) {
          if (parentNode.arguments.length === 1) {
            indexNode = parentNode.arguments[0];
          }
          parentNode = getParent(parentNode);
        } else {
          indexNode = node.property;
        }

        if (
          indexNode == null ||
          !isEqualityComparison(parentNode) ||
          !isStringType(node.object)
        ) {
          return;
        }

        const isEndsWith = isLastIndexExpression(indexNode, node.object);
        if (allowSingleElementEquality === 'always' && isEndsWith) {
          return;
        }

        const isStartsWith = !isEndsWith && isNumber(indexNode, 0);
        if (
          (allowSingleElementEquality === 'always' && isStartsWith) ||
          (!isStartsWith && !isEndsWith)
        ) {
          return;
        }

        const eqNode = parentNode;
        context.report({
          node: parentNode,
          messageId: isStartsWith ? 'preferStartsWith' : 'preferEndsWith',
          fix(fixer) {
            // Don't fix if it can change the behavior.
            if (!isCharacter(eqNode.right)) {
              return null;
            }
            return fixWithRightOperand(
              fixer,
              eqNode,
              isStartsWith ? 'start' : 'end',
              eqNode.operator.startsWith('!'),
              node.optional,
            );
          },
        });
      },

      // foo.indexOf('bar') === 0
      [[
        'BinaryExpression > CallExpression.left > MemberExpression.callee[property.name="indexOf"][computed=false]',
        'BinaryExpression > ChainExpression.left > CallExpression > MemberExpression.callee[property.name="indexOf"][computed=false]',
      ].join(', ')](node: TSESTree.MemberExpression): void {
        const callNode = getParent(node) as TSESTree.CallExpression;
        const parentNode = getParent(callNode);

        if (
          callNode.arguments.length !== 1 ||
          !isEqualityComparison(parentNode) ||
          !isNumber(parentNode.right, 0) ||
          !isStringType(node.object)
        ) {
          return;
        }

        context.report({
          node: parentNode,
          messageId: 'preferStartsWith',
          fix(fixer) {
            return fixWithArgument(
              fixer,
              parentNode,
              callNode,
              node,
              'start',
              parentNode.operator.startsWith('!'),
              node.optional,
            );
          },
        });
      },

      // foo.lastIndexOf('bar') === foo.length - 3
      // foo.lastIndexOf(bar) === foo.length - bar.length
      [[
        'BinaryExpression > CallExpression.left > MemberExpression.callee[property.name="lastIndexOf"][computed=false]',
        'BinaryExpression > ChainExpression.left > CallExpression > MemberExpression.callee[property.name="lastIndexOf"][computed=false]',
      ].join(', ')](node: TSESTree.MemberExpression): void {
        const callNode = getParent(node) as TSESTree.CallExpression;
        const parentNode = getParent(callNode);

        if (
          callNode.arguments.length !== 1 ||
          !isEqualityComparison(parentNode) ||
          parentNode.right.type !== AST_NODE_TYPES.BinaryExpression ||
          parentNode.right.operator !== '-' ||
          !isLengthExpression(parentNode.right.left, node.object) ||
          !isLengthExpression(parentNode.right.right, callNode.arguments[0]) ||
          !isStringType(node.object)
        ) {
          return;
        }

        context.report({
          node: parentNode,
          messageId: 'preferEndsWith',
          fix(fixer) {
            return fixWithArgument(
              fixer,
              parentNode,
              callNode,
              node,
              'end',
              parentNode.operator.startsWith('!'),
              node.optional,
            );
          },
        });
      },

      // foo.match(/^bar/) === null
      // foo.match(/bar$/) === null
      [[
        'BinaryExpression > CallExpression.left > MemberExpression.callee[property.name="match"][computed=false]',
        'BinaryExpression > ChainExpression.left > CallExpression > MemberExpression.callee[property.name="match"][computed=false]',
      ].join(', ')](node: TSESTree.MemberExpression): void {
        const callNode = getParent(node) as TSESTree.CallExpression;
        const parentNode = getParent(callNode) as TSESTree.BinaryExpression;

        if (!isNull(parentNode.right) || !isStringType(node.object)) {
          return;
        }

        const parsed =
          callNode.arguments.length === 1
            ? parseRegExp(callNode.arguments[0])
            : null;
        if (parsed == null) {
          return;
        }

        const { isStartsWith, text } = parsed;
        context.report({
          node: callNode,
          messageId: isStartsWith ? 'preferStartsWith' : 'preferEndsWith',
          *fix(fixer) {
            if (!parentNode.operator.startsWith('!')) {
              yield fixer.insertTextBefore(parentNode, '!');
            }
            yield fixer.replaceTextRange(
              getPropertyRange(node),
              `${node.optional ? '?.' : '.'}${
                isStartsWith ? 'start' : 'end'
              }sWith`,
            );
            yield fixer.replaceText(
              callNode.arguments[0],
              JSON.stringify(text),
            );
            yield fixer.removeRange([callNode.range[1], parentNode.range[1]]);
          },
        });
      },

      // foo.slice(0, 3) === 'bar'
      // foo.slice(-3) === 'bar'
      // foo.slice(-3, foo.length) === 'bar'
      // foo.substring(0, 3) === 'bar'
      // foo.substring(foo.length - 3) === 'bar'
      // foo.substring(foo.length - 3, foo.length) === 'bar'
      [[
        'BinaryExpression > CallExpression.left > MemberExpression',
        'BinaryExpression > ChainExpression.left > CallExpression > MemberExpression',
      ].join(', ')](node: TSESTree.MemberExpression): void {
        if (!isStaticMemberAccessOfValue(node, context, 'slice', 'substring')) {
          return;
        }
        const callNode = getParent(node) as TSESTree.CallExpression;
        const parentNode = getParent(callNode);

        if (!isEqualityComparison(parentNode) || !isStringType(node.object)) {
          return;
        }

        let isEndsWith = false;
        let isStartsWith = false;
        if (callNode.arguments.length === 1) {
          if (
            // foo.slice(-bar.length) === bar
            // foo.slice(foo.length - bar.length) === bar
            isLengthAheadOfEnd(
              callNode.arguments[0],
              parentNode.right,
              node.object,
            )
          ) {
            isEndsWith = true;
          }
        } else if (callNode.arguments.length === 2) {
          if (
            // foo.slice(0, bar.length) === bar
            isNumber(callNode.arguments[0], 0) &&
            isLengthExpression(callNode.arguments[1], parentNode.right)
          ) {
            isStartsWith = true;
          } else if (
            // foo.slice(foo.length - bar.length, foo.length) === bar
            // foo.slice(foo.length - bar.length, 0) === bar
            // foo.slice(-bar.length, foo.length) === bar
            // foo.slice(-bar.length, 0) === bar
            (isLengthExpression(callNode.arguments[1], node.object) ||
              isNumber(callNode.arguments[1], 0)) &&
            isLengthAheadOfEnd(
              callNode.arguments[0],
              parentNode.right,
              node.object,
            )
          ) {
            isEndsWith = true;
          }
        }

        if (!isStartsWith && !isEndsWith) {
          return;
        }

        const eqNode = parentNode;
        const negativeIndexSupported =
          (node.property as TSESTree.Identifier).name === 'slice';
        context.report({
          node: parentNode,
          messageId: isStartsWith ? 'preferStartsWith' : 'preferEndsWith',
          fix(fixer) {
            // Don't fix if it can change the behavior.
            if (
              eqNode.operator.length === 2 &&
              (eqNode.right.type !== AST_NODE_TYPES.Literal ||
                typeof eqNode.right.value !== 'string')
            ) {
              return null;
            }
            // code being checked is likely mistake:
            // unequal length of strings being checked for equality
            // or reliant on behavior of substring (negative indices interpreted as 0)
            if (isStartsWith) {
              if (!isLengthExpression(callNode.arguments[1], eqNode.right)) {
                return null;
              }
            } else {
              const posNode = callNode.arguments[0];
              const posNodeIsAbsolutelyValid =
                (posNode.type === AST_NODE_TYPES.BinaryExpression &&
                  posNode.operator === '-' &&
                  isLengthExpression(posNode.left, node.object) &&
                  isLengthExpression(posNode.right, eqNode.right)) ||
                (negativeIndexSupported &&
                  posNode.type === AST_NODE_TYPES.UnaryExpression &&
                  posNode.operator === '-' &&
                  isLengthExpression(posNode.argument, eqNode.right));
              if (!posNodeIsAbsolutelyValid) {
                return null;
              }
            }

            return fixWithRightOperand(
              fixer,
              parentNode,
              isStartsWith ? 'start' : 'end',
              parentNode.operator.startsWith('!'),
              node.optional,
            );
          },
        });
      },

      // /^bar/.test(foo)
      // /bar$/.test(foo)
      'CallExpression > MemberExpression.callee[property.name="test"][computed=false]'(
        node: TSESTree.MemberExpression,
      ): void {
        const callNode = getParent(node) as TSESTree.CallExpression;
        const parsed =
          callNode.arguments.length === 1 ? parseRegExp(node.object) : null;
        if (parsed == null) {
          return;
        }

        const { isStartsWith, text } = parsed;
        const messageId = isStartsWith ? 'preferStartsWith' : 'preferEndsWith';
        const methodName = isStartsWith ? 'startsWith' : 'endsWith';
        context.report({
          node: callNode,
          messageId,
          *fix(fixer) {
            const argNode = callNode.arguments[0];
            const needsParen =
              argNode.type !== AST_NODE_TYPES.Literal &&
              argNode.type !== AST_NODE_TYPES.TemplateLiteral &&
              argNode.type !== AST_NODE_TYPES.Identifier &&
              argNode.type !== AST_NODE_TYPES.MemberExpression &&
              argNode.type !== AST_NODE_TYPES.CallExpression;

            yield fixer.removeRange([callNode.range[0], argNode.range[0]]);
            if (needsParen) {
              yield fixer.insertTextBefore(argNode, '(');
              yield fixer.insertTextAfter(argNode, ')');
            }
            yield fixer.insertTextAfter(
              argNode,
              `${node.optional ? '?.' : '.'}${methodName}(${JSON.stringify(
                text,
              )}`,
            );
          },
        });
      },
    };
  },
});
