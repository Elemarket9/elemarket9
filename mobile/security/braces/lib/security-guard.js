'use strict';
module.exports = function guard(ast) {
  const pending = [[ast, 0]];
  const seen = new Set();
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > 128 || seen.has(node) || seen.size >= 100000) {
      throw new SyntaxError('Invalid or excessively nested brace AST');
    }
    seen.add(node);
    if (Array.isArray(node.nodes)) {
      for (const child of node.nodes) pending.push([child, depth + 1]);
    }
  }
};
