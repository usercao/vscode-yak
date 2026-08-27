import {
  type TemplateLibraryProfile,
  type TemplateTag,
  templateLibraryProfiles,
} from './templateLibraries.ts'

type GrammarLanguage = 'javascript' | 'typescript'

interface InjectionGrammarOptions {
  injectionSelector: string
  language: GrammarLanguage
  scopeName: string
}

type TextMateGrammar = Record<string, unknown>

export function getStaticGrammarTags(
  profiles: readonly TemplateLibraryProfile[] = templateLibraryProfiles,
): ReadonlyMap<string, TemplateTag> {
  const tags = new Map<string, TemplateTag>()

  for (const profile of profiles) {
    for (const tagName of profile.staticGrammar.styledLikeTagNames) {
      addTag(tags, tagName, 'styled')
    }

    for (const tagName of profile.staticGrammar.namedTagNames) {
      const tag = profile.namedImports[tagName] ?? profile.namespaceImports[tagName]

      if (!tag) {
        throw new Error(`Static grammar tag "${tagName}" is not a recognized template tag.`)
      }

      addTag(tags, tagName, tag)
    }
  }

  return tags
}

export function createInjectionGrammar(options: InjectionGrammarOptions): TextMateGrammar {
  const tags = getStaticGrammarTags()
  const styledTagNames = getTagNames(tags, 'styled')
  const namedTagNames = getTagNames(tags, 'css', 'globalStyle')
  const keyframesTagNames = getTagNames(tags, 'keyframes')
  const interpolationName = `meta.embedded.line.${options.language === 'typescript' ? 'ts' : 'js'}`
  const interpolationKey = `interpolation-${options.language === 'typescript' ? 'ts' : 'js'}`
  const expressionScope = `source.${options.language === 'typescript' ? 'ts' : 'js'}#expression`
  const typeArgument = createTypeArgumentPattern()

  return {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    scopeName: options.scopeName,
    injectionSelector: options.injectionSelector,
    patterns: [
      createTemplatePattern(styledTagNames, interpolationKey, {
        suffix:
          `(?:\\s*\\.\\s*[_$[:alpha:]][_$[:alnum:]]*${typeArgument}|\\s*\\[\\s*['"][^'"\`\\n]+['"]\\s*\\]${typeArgument}|\\s*\\([^\`\\n]*\\)${typeArgument})(?:\\s*\\.\\s*attrs${typeArgument}\\s*\\([^\`\\n]*\\))*\\s*(\`)`,
        primitiveTypeCaptureIndices: options.language === 'typescript' ? [2, 3, 4, 5] : [],
        templateBeginCaptureIndex: 6,
      }),
      createTemplatePattern(namedTagNames, interpolationKey, { suffix: '\\s*(`)' }),
      createTemplatePattern(keyframesTagNames, interpolationKey, {
        includeKeyframeStep: true,
        suffix: '\\s*(`)',
      }),
    ],
    repository: {
      'keyframe-step': {
        patterns: [
          createKeyframeStepPattern(
            '(from|to)',
            'entity.other.keyframe-offset.css',
            interpolationKey,
          ),
          createKeyframeStepPattern(
            '((?:\\d+(?:\\.\\d+)?%)(?:\\s*,\\s*\\d+(?:\\.\\d+)?%)*)',
            'entity.other.keyframe-offset.percentage.css',
            interpolationKey,
          ),
        ],
      },
      'root-selector': {
        begin:
          '(?m)^(?=\\s*(?:[^{}\\n]*)(?:::[-_a-zA-Z][-_a-zA-Z0-9]*|:[-_a-zA-Z][-_a-zA-Z0-9]*)(?:[^{}\\n]*)\\{)',
        end: '(?=\\{)',
        name: 'meta.selector.css',
        patterns: [{ include: 'source.css#selector-innards' }],
      },
      'root-incomplete-selector': {
        begin:
          '(?m)^(\\s*)(?=[a-zA-Z][-_a-zA-Z0-9]*(?::(?:active|any-link|checked|disabled|empty|enabled|first|(?:first|last|only)-(?:child|of-type)|focus|focus-visible|focus-within|fullscreen|host|hover|in-range|indeterminate|invalid|left|link|optional|out-of-range|read-only|read-write|required|right|root|scope|target|unresolved|valid|visited)(?![-_a-zA-Z0-9])|::?(?:after|before|first-letter|first-line|backdrop|content|grammar-error|marker|placeholder|selection|shadow|spelling-error)(?![-_a-zA-Z0-9])|:(?:dir|lang|not|has|matches|where|is|nth-(?:last-)?(?:child|of-type))\\()[^{};\\n]*$)',
        end: '$',
        name: 'meta.selector.css',
        patterns: [{ include: 'source.css#selector-innards' }],
      },
      [interpolationKey]: {
        name: interpolationName,
        begin: '\\$\\{',
        beginCaptures: {
          0: { name: 'punctuation.definition.template-expression.begin.yak' },
        },
        end: '\\}',
        endCaptures: {
          0: { name: 'punctuation.definition.template-expression.end.yak' },
        },
        patterns: [{ include: expressionScope }],
      },
      'root-declaration': {
        patterns: [
          createDeclarationPattern('--[-_a-zA-Z][-_a-zA-Z0-9]*', 'variable.css', interpolationKey),
          createDeclarationPattern(
            '[a-zA-Z-]+',
            'meta.property-name.css support.type.property-name.css',
            interpolationKey,
          ),
        ],
      },
    },
  }
}

function addTag(tags: Map<string, TemplateTag>, tagName: string, tag: TemplateTag) {
  const existingTag = tags.get(tagName)

  if (existingTag && existingTag !== tag) {
    throw new Error(`Static grammar tag "${tagName}" has conflicting meanings.`)
  }

  tags.set(tagName, tag)
}

function getTagNames(tags: ReadonlyMap<string, TemplateTag>, ...requestedTags: TemplateTag[]) {
  return [...tags]
    .filter(([, tag]) => requestedTags.includes(tag))
    .map(([tagName]) => tagName)
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
}

function createTypeArgumentPattern() {
  const primitiveTypes = 'any|bigint|boolean|never|null|number|object|string|symbol|undefined|unknown|void'

  return `(?:\\s*<[^\`\\n]*?\\b(${primitiveTypes})\\b[^\`\\n]*>|\\s*<[^\`\\n]*>)?`
}

function createTemplatePattern(
  tagNames: readonly string[],
  interpolationKey: string,
  options: {
    includeKeyframeStep?: boolean
    primitiveTypeCaptureIndices?: readonly number[]
    suffix: string
    templateBeginCaptureIndex?: number
  },
): TextMateGrammar {
  const tagExpression = createTagExpression(tagNames)
  const patterns: TextMateGrammar[] = [{ include: `#${interpolationKey}` }]
  const beginCaptures: TextMateGrammar = {
    1: { name: 'entity.name.function.tagged-template.yak' },
    [options.templateBeginCaptureIndex ?? 2]: {
      name: 'punctuation.definition.string.template.begin.yak',
    },
  }

  for (const captureIndex of options.primitiveTypeCaptureIndices ?? []) {
    beginCaptures[captureIndex] = { name: 'support.type.primitive.ts' }
  }

  if (options.includeKeyframeStep) {
    patterns.push({ include: '#keyframe-step' })
  }

  patterns.push(
    { include: '#root-selector' },
    { include: '#root-incomplete-selector' },
    { include: '#root-declaration' },
    { include: 'source.css' },
  )

  return {
    name: 'meta.embedded.block.css.yak',
    contentName: 'source.css',
    begin: `(?<![_$[:alnum:].])(?:(?:[_$[:alpha:]][_$[:alnum:]]*)\\s*\\.\\s*)?(${tagExpression})${options.suffix}`,
    beginCaptures,
    end: '`',
    endCaptures: {
      0: { name: 'punctuation.definition.string.template.end.yak' },
    },
    patterns,
  }
}

function createTagExpression(tagNames: readonly string[]) {
  if (tagNames.length === 0) {
    throw new Error('Static grammar must define at least one tag name.')
  }

  return tagNames.map(escapeRegex).join('|')
}

function escapeRegex(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function createKeyframeStepPattern(
  stepExpression: string,
  offsetScope: string,
  interpolationKey: string,
): TextMateGrammar {
  return {
    name: 'meta.keyframe-step.css',
    begin: `(?m)^(\\s*)${stepExpression}(\\s*)(\\{)`,
    beginCaptures: {
      2: {
        name: offsetScope,
      },
      4: { name: 'punctuation.section.property-list.begin.bracket.curly.css' },
    },
    end: '(\\})|(?=`)',
    endCaptures: {
      1: { name: 'punctuation.section.property-list.end.bracket.curly.css' },
    },
    patterns: [{ include: `#${interpolationKey}` }, { include: 'source.css#rule-list-innards' }],
  }
}

function createDeclarationPattern(
  propertyExpression: string,
  propertyName: string,
  interpolationKey: string,
): TextMateGrammar {
  return {
    name: 'meta.property-list.yak',
    contentName: 'meta.property-value.css',
    begin: `(?m)^(\\s*)(${propertyExpression})(\\s*:\\s*)`,
    beginCaptures: {
      2: { name: propertyName },
      3: { name: 'punctuation.separator.key-value.css' },
    },
    end: '(;)|(?=\\n|`|\\})',
    endCaptures: {
      1: { name: 'punctuation.terminator.rule.css' },
    },
    patterns: [{ include: `#${interpolationKey}` }, { include: 'source.css#property-values' }],
  }
}
