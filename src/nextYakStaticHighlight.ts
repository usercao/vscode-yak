import {
  NextYakStaticTemplateCache,
  type NextYakTemplateDocument,
} from './nextYakTemplate'

export function getNextYakStaticHighlightRanges(
  document: NextYakTemplateDocument,
  staticTemplateCache: NextYakStaticTemplateCache,
) {
  return staticTemplateCache.findTemplates(document)
    .map((template) => ({
      end: template.tagEnd,
      start: template.tagStart,
    }))
    .filter((range) => range.start < range.end)
}
