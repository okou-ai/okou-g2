import { CreateStartUpPageContainer, RebuildPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk'

export interface LensPage { heading: string; body: string; footer: string }

function containers(page: LensPage) {
  return [page.heading, page.body, page.footer].map((content, i) => new TextContainerProperty({
    containerID: i + 1, containerName: ['title', 'body', 'status'][i], xPosition: 4,
    yPosition: [0, 36, 249][i], width: 568, height: [34, 212, 39][i], paddingLength: 2,
    content, isEventCapture: i === 1 ? 1 : 0,
  }))
}

export const startupPage = () => new CreateStartUpPageContainer({
  containerTotalNum: 3, textObject: containers({ heading: 'Okou', body: 'Opening conversation…', footer: '' }),
})

export const lensPage = (page: LensPage) => new RebuildPageContainer({
  containerTotalNum: 3, textObject: containers(page),
})

/** Leave headroom for the G2 font. Wide glyphs consume two columns; line
 * breaks in code and lists remain visible. Never shorten a reply to fit. */
export function paginate(text: string): string[] {
  const pages: string[] = []
  let lines: string[] = [], line = '', width = 0
  const finishLine = () => {
    lines.push(line)
    line = ''
    width = 0
    if (lines.length === 6) { pages.push(lines.join('\n')); lines = [] }
  }
  const segments = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    : Array.from(text)
  for (const char of segments) {
    if (char === '\n') { finishLine(); continue }
    const cells = char === '\t' ? 4 : char.codePointAt(0)! >= 0x1100 ? 2 : 1
    if (width + cells > 36) finishLine()
    line += char === '\t' ? '    ' : char
    width += cells
  }
  if (line || lines.length) finishLine()
  if (lines.length) pages.push(lines.join('\n'))
  return pages.length ? pages : ['']
}
