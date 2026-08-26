import type { Template } from './template'

export interface CssFoldingRange {
  end: number
  start: number
}

export function getCssFoldingRanges(
  source: string,
  template: Template,
): readonly CssFoldingRange[] {
  const openBlocks: number[] = []
  const ranges: CssFoldingRange[] = []
  const body = template.maskedBody
  let inComment = false
  let line = lineAt(source, template.bodyStart)
  let quote: '"' | "'" | undefined

  for (let offset = 0; offset < body.length; offset += 1) {
    const character = body[offset]
    const nextCharacter = body[offset + 1]

    if (character === '\n') {
      line += 1
    }

    if (inComment) {
      if (character === '*' && nextCharacter === '/') {
        inComment = false
        offset += 1
      }
      continue
    }

    if (quote) {
      if (character === '\\') {
        offset += 1
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }

    if (character === '/' && nextCharacter === '*') {
      inComment = true
      offset += 1
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      continue
    }

    if (character === '{') {
      openBlocks.push(line)
      continue
    }

    if (character === '}') {
      const start = openBlocks.pop()

      if (start === undefined) {
        continue
      }

      if (line > start) {
        ranges.push({ end: line, start })
      }
    }
  }

  return ranges
}

function lineAt(source: string, offset: number): number {
  let line = 0

  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      line += 1
    }
  }

  return line
}
