import { createRequire } from 'node:module'

const requireFromDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))

export function loadTypeScript() {
  try {
    return requireFromDesktop('typescript')
  } catch (error) {
    throw new Error(`无法从 apps/desktop 解析 typescript，请先准备仓库现有开发依赖 (${error.code ?? error.message})`, { cause: error })
  }
}

function unwrap(ts, expression) {
  let node = expression
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))) {
    node = node.expression
  }
  return node
}

function literal(ts, node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text
}

function propertyName(ts, node) {
  if (ts.isComputedPropertyName(node)) return literal(ts, unwrap(ts, node.expression))
  return ts.isIdentifier(node) ? node.text : literal(ts, node)
}

function properties(ts, object, fail) {
  const seen = new Set()
  return object.properties.map((member) => {
    if (!ts.isPropertyAssignment(member) && !ts.isMethodDeclaration(member)) {
      fail(member, 'api members must be explicit properties or methods; spread, shorthand and accessors are unsupported')
    }
    const name = propertyName(ts, member.name)
    if (!name || !/^[a-zA-Z_$][\w$]*$/.test(name) || name === '__proto__') {
      fail(member, 'api member needs a static identifier-like key')
    }
    if (seen.has(name)) fail(member, `duplicate api member ${name}`)
    seen.add(name)
    return { name, member, value: ts.isPropertyAssignment(member) ? unwrap(ts, member.initializer) : member }
  })
}

function stableValue(ts, node) {
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const owner = stableValue(ts, node.expression)
    if (owner) return `${owner}.${node.name.text}`
  }
  if (ts.isIdentifier(node)) return node.text
  const text = literal(ts, node)
  if (text !== undefined) return JSON.stringify(text)
  if (ts.isNumericLiteral(node)) return node.text
  if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) {
    return node.getText()
  }
}

function ipcOperation(ts, node) {
  if (!ts.isCallExpression(node)) return
  const target = unwrap(ts, node.expression)
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return
  const owner = unwrap(ts, target.expression)
  if (!ts.isIdentifier(owner) || owner.text !== 'ipcRenderer') return
  return {
    node,
    optional: !!node.questionDotToken || !!target.questionDotToken,
    kind: ts.isPropertyAccessExpression(target) ? target.name.text : literal(ts, unwrap(ts, target.argumentExpression)),
    channel: literal(ts, unwrap(ts, node.arguments[0])),
    listener: unwrap(ts, node.arguments[1])
  }
}

function immediateCall(ts, rawBody, call, allowExpressionStatement) {
  const body = unwrap(ts, rawBody)
  if (!ts.isBlock(body)) return body === call
  return body.statements.some((statement) =>
    (ts.isReturnStatement(statement) || (allowExpressionStatement && ts.isExpressionStatement(statement))) &&
    unwrap(ts, statement.expression) === call)
}

function readMethod(ts, value, id, fail) {
  const calls = []
  const visit = (node) => {
    const operation = ipcOperation(ts, node)
    if (operation) calls.push(operation)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(value.body, visit)
  const bodyOperation = ipcOperation(ts, value.body)
  if (bodyOperation) calls.unshift(bodyOperation)
  for (const call of calls) {
    if (!['invoke', 'send', 'sendSync', 'on', 'removeListener'].includes(call.kind) || !call.channel) {
      fail(call.node, `${id}: unsupported IPC operation or nonliteral channel`)
    }
  }
  const adds = calls.filter(({ kind }) => kind === 'on')
  if (adds.length) {
    const removals = calls.filter(({ kind }) => kind === 'removeListener')
    const [add] = adds
    const [remove] = removals
    if (calls.length !== 2 || adds.length !== 1 || removals.length !== 1 ||
      add.channel !== remove.channel || !add.listener || !remove.listener ||
      !ts.isIdentifier(add.listener) || !ts.isIdentifier(remove.listener) || add.listener.text !== remove.listener.text) {
      fail(value, `${id}: expected one subscription and matching channel/listener cleanup`)
    }
    const body = unwrap(ts, value.body)
    const returns = ts.isBlock(body) ? body.statements.filter(ts.isReturnStatement).map((n) => unwrap(ts, n.expression)) : []
    const [cleanup] = returns
    if (returns.length !== 1 || !cleanup || (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) ||
      remove.node.getStart() < cleanup.getStart() || remove.node.getEnd() > cleanup.getEnd() ||
      (add.node.getStart() >= cleanup.getStart() && add.node.getEnd() <= cleanup.getEnd())) {
      fail(value, `${id}: matching cleanup must be returned as a disposer`)
    }
    return { kind: 'subscription', channel: add.channel }
  }
  if (calls.length !== 1 || calls[0].kind === 'removeListener') {
    fail(value, `${id}: expected exactly one invoke/send/sendSync call or one subscription`)
  }
  const [{ kind, channel }] = calls
  return { kind, channel }
}

/** Read the actual preload object, not the declaration files or DTO imports. */
export function extractInventory(source, filename = 'preload/index.ts', ts = loadTypeScript()) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fail = (node, message) => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file))
    throw new Error(`${filename}:${line + 1}:${character + 1}: ${message}`)
  }
  const [diagnostic] = file.parseDiagnostics
  if (diagnostic) {
    const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
    throw new Error(`${filename}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
  }
  const candidates = file.statements.filter(ts.isVariableStatement).flatMap(({ declarationList }) =>
    [...declarationList.declarations].filter(({ name }) => ts.isIdentifier(name) && name.text === 'api'))
  if (candidates.length !== 1) fail(file, 'expected one top-level const api = { ... }')
  const [declaration] = candidates
  const api = unwrap(ts, declaration.initializer)
  if (!(declaration.parent.flags & ts.NodeFlags.Const) || !api || !ts.isObjectLiteralExpression(api)) {
    fail(declaration, 'expected top-level const api to have an object literal initializer')
  }
  const inventory = { groups: [], values: [] }
  for (const { name, member, value } of properties(ts, api, fail)) {
    if (!ts.isObjectLiteralExpression(value)) {
      const expression = stableValue(ts, value)
      if (!expression) fail(member, `${name}: expected a group or static value source`)
      inventory.values.push({ name, expression })
      continue
    }
    const methods = properties(ts, value, fail).map(({ name: method, member: item, value: fn }) => {
      if ((!ts.isMethodDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) || !fn.body) {
        fail(item, `${name}.${method}: expected an inline method implementation`)
      }
      return { name: method, ...readMethod(ts, fn, `${name}.${method}`, fail) }
    })
    inventory.groups.push({ name, methods })
  }
  return inventory
}

export function inventoryCounts({ groups, values }) {
  const methods = groups.flatMap((group) => group.methods)
  return { groups: groups.length, methods: methods.length,
    subscriptions: methods.filter(({ kind }) => kind === 'subscription').length, values: values.length }
}
