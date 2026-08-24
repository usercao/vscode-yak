const assert = require('node:assert/strict')
const vscode = require('vscode')

const cursorMarker = '/*cursor*/'

async function completionLabels(source) {
  const cursorOffset = source.indexOf(cursorMarker)

  assert.notEqual(cursorOffset, -1, `Missing ${cursorMarker} marker`)

  const document = await vscode.workspace.openTextDocument({
    language: 'typescriptreact',
    content: source.replace(cursorMarker, ''),
  })
  await vscode.window.showTextDocument(document)

  const completionList = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    document.uri,
    document.positionAt(cursorOffset),
  )

  return completionList?.items.map((item) => typeof item.label === 'string' ? item.label : item.label.label) ?? []
}

async function assertIncludesPseudoCompletion(selector, expectedLabel) {
  const labels = await completionLabels([
    "import { styled } from 'next-yak'",
    'const Link = styled.a`',
    `  ${selector}${cursorMarker}`,
    '`',
  ].join('\n'))

  assert.ok(labels.includes(expectedLabel), `Expected ${expectedLabel} in ${labels.join(', ')}`)
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension('local.next-yak-vscode')

  assert.ok(extension, 'The next-yak extension should be available in the Extension Development Host')
  await extension.activate()

  await assertIncludesPseudoCompletion('a:', ':hover')
  await assertIncludesPseudoCompletion('a::', '::before')

  const aliasLabels = await completionLabels([
    "import { styled as s } from 'next-yak'",
    'const Panel = s.div`',
    `  col${cursorMarker}`,
    '`',
  ].join('\n'))
  assert.ok(aliasLabels.includes('color'), `Expected color in ${aliasLabels.join(', ')}`)

  const namespaceLabels = await completionLabels([
    "import * as yak from 'next-yak'",
    'const rules = yak.css`',
    `  col${cursorMarker}`,
    '`',
  ].join('\n'))
  assert.ok(namespaceLabels.includes('color'), `Expected color in ${namespaceLabels.join(', ')}`)

  const shadowedLabels = await completionLabels([
    "import { styled } from 'next-yak'",
    'function create(styled) {',
    '  return styled.a`',
    `    a:${cursorMarker}`,
    '  `',
    '}',
  ].join('\n'))
  assert.ok(!shadowedLabels.includes(':hover'), 'Locally shadowed styled should not receive next-yak CSS completion')
}
