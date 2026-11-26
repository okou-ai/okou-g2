export const LENS_WIDTH = 576
export const LENS_HEIGHT = 288
export const PAGE_LINES = 7
export const LINE_CELLS = 36

export const LENS_CONTEXT = [
  'The user sent this voice message from Even Realities G2 glasses.',
  `The ${LENS_WIDTH} × ${LENS_HEIGHT} monochrome lens shows the latest assistant reply one page at a time. The wearer swipes to read further pages.`,
  `The reader budgets ${PAGE_LINES} lines per page, about ${LINE_CELLS} Latin characters or ${LINE_CELLS / 2} full-width Chinese characters per line. Fit varies with glyph widths and line breaks.`,
  'The lens shows plain text. Links and images appear as their labels. Tables and code appear as text, and headings and bold have no special styling.',
].join(' ')
