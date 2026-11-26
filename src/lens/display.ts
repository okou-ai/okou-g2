export const LENS_WIDTH = 576
export const LENS_HEIGHT = 288
export const LINE_HEIGHT = 27
export const PAGE_LINES = Math.floor((LENS_HEIGHT - 2 * LINE_HEIGHT) / LINE_HEIGHT)
const bodyHeight = PAGE_LINES * LINE_HEIGHT
export const BODY = { x: 4, y: (LENS_HEIGHT - bodyHeight) / 2, width: LENS_WIDTH - 8, height: bodyHeight }

export const LENS_CONTEXT = [
  'The user sent this voice message from Even Realities G2 glasses.',
  `The ${LENS_WIDTH} × ${LENS_HEIGHT} monochrome lens shows the latest assistant reply one page at a time. The wearer swipes to read further pages.`,
  `The reply area fits ${PAGE_LINES} lines, each ${BODY.width} pixels wide. A line typically fits about 28 full-width Chinese characters or 60 characters of English prose. Fit varies with glyph widths, word wrapping and explicit line breaks.`,
  'The lens shows plain text. Links and images appear as their labels. Tables and code appear as text, and headings and bold have no special styling.',
].join(' ')
