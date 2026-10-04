import ts from 'typescript';

/** Read syntax rather than prose: a user-facing sentence may contain "document.". */
export function containsDomGlobals(source) {
  const tree = ts.createSourceFile(
    'worker.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let found = false;
  const forbidden = (name) => name === 'window' || name === 'document';
  function visit(node) {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && forbidden(node.expression.text)) found = true;
      if (
        ts.isIdentifier(node.expression) &&
        ['globalThis', 'self'].includes(node.expression.text)
      ) {
        const name = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
            ? node.argumentExpression.text
            : '';
        if (forbidden(name)) found = true;
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      forbidden(node.expression.text)
    )
      found = true;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}
