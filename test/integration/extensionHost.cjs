const assert = require('node:assert/strict')
const vscode = require('vscode')

const cursorMarker = '/*cursor*/'

async function completionItems(source) {
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

  return { document, items: completionList?.items ?? [] }
}

async function completionLabels(source) {
  const { items } = await completionItems(source)
  return items.map((item) => typeof item.label === 'string' ? item.label : item.label.label)
}

async function assertPseudoCompletion(selector, expectedLabel, expectedInsertText) {
  const { document, items } = await completionItems([
    "import { styled } from 'next-yak'",
    'const Link = styled.a`',
    `  ${selector}${cursorMarker}`,
    '`',
  ].join('\n'))
  const completion = items.find((item) => (typeof item.label === 'string' ? item.label : item.label.label) === expectedLabel)

  assert.ok(completion, `Expected ${expectedLabel} in ${items.map((item) => item.label).join(', ')}`)
  assert.ok(completion.range instanceof vscode.Range, `Expected ${expectedLabel} to define a replacement range`)
  assert.equal(document.getText(completion.range), selector)
  assert.equal(completion.filterText, selector)
  assert.equal(completion.insertText, expectedInsertText)
  assert.match(completion.sortText ?? '', /^!/)
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension('local.next-yak-vscode')

  assert.ok(extension, 'The next-yak extension should be available in the Extension Development Host')
  await extension.activate()

  await assertPseudoCompletion('a:', ':hover', 'a:hover')
  await assertPseudoCompletion('a::', '::before', 'a::before')

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
