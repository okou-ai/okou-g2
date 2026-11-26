import {
  CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty,
  RebuildPageContainer, TextContainerProperty, TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import { BODY, LENS_HEIGHT, LENS_WIDTH, LINE_HEIGHT } from './display'
import { orbitContainer } from './orbit'
import { standbyContainer } from './standby'

export type LensMode = 'quiet' | 'reader' | 'voice'
export type Indicator = 'off' | 'unread' | 'working'
export interface LensPage {
  mode: LensMode
  menu: boolean
  orbit: boolean
  body: string
  status: string
  primaryHint: string
  scrollHint: string
  secondaryHint: string
  indicator: Indicator
}

const actions = ['cancel', 'launcher', 'back'] as const
const labels = {
  cancel: ['Cancel current task', '取消当前任务'],
  launcher: ['Back to main menu', '返回主菜单'],
  back: ['Back to Okou', '回到 Okou'],
} as const

export function menuItems() {
  const language = globalThis.navigator?.language?.startsWith('zh') ? 1 : 0
  return actions.map(action => ({ action, label: labels[action][language] }))
}

function text(id: number, name: string, content: string, x: number, y: number, width: number, height: number) {
  return new TextContainerProperty({
    containerID: id, containerName: name, content, xPosition: x, yPosition: y,
    width, height, paddingLength: 0, isEventCapture: id === 1 ? 1 : 0,
  })
}

const DOT = { containerID: 3, containerName: 'indicator' }
const DOT_GLYPH = '●'
export function indicatorUpdate(level: number) {
  return new TextContainerUpgrade({ ...DOT, content: level ? DOT_GLYPH : ' ', textColor: level })
}

const VOICE = { containerID: 4, containerName: 'voice-status' }
// The native font has proportional ASCII numerals. Its full-width numerals keep
// both the label and the right edge of the clock stationary on every tick.
const clockNumber = new Intl.NumberFormat('en', {
  numberingSystem: 'fullwide', minimumIntegerDigits: 2, useGrouping: false,
})
export function listeningLabel(seconds: number) {
  return '● Listening ' + clockNumber.format(Math.floor(seconds / 60)) + ':' + clockNumber.format(seconds % 60)
}
export function statusUpdate(content: string, level: number) {
  return new TextContainerUpgrade({ ...VOICE, content, textColor: level })
}

function layout(page: LensPage, level: number) {
  const boxes: TextContainerProperty[] = []
  const footerY = LENS_HEIGHT - LINE_HEIGHT
  if (page.mode === 'quiet') {
    boxes.push(text(1, 'body', '', BODY.x, BODY.y, BODY.width, BODY.height))
    if (page.indicator === 'off') return { containerTotalNum: 1, textObject: boxes }
    const unread = page.indicator === 'unread'
    if (unread) boxes.push(text(2, 'title', 'OKOU', 27, 0, getTextWidth('OKOU'), LINE_HEIGHT))
    return { containerTotalNum: boxes.length + 1, textObject: boxes, imageObject: [standbyContainer(unread)] }
  }
  const title = text(2, 'title', 'OKOU', 0, 0, getTextWidth('OKOU'), LINE_HEIGHT)
  if (page.orbit) title.isEventCapture = 1
  boxes.push(title)
  if (page.status) {
    const width = getTextWidth(page.status)
    const status = text(VOICE.containerID, VOICE.containerName, page.status, LENS_WIDTH - width, 0, width, LINE_HEIGHT)
    status.textColor = level
    boxes.push(status)
  } else if (!page.orbit) {
    const width = getTextWidth(DOT_GLYPH)
    const dot = text(DOT.containerID, DOT.containerName, page.indicator === 'off' ? '' : DOT_GLYPH, LENS_WIDTH - width, 0, width, LINE_HEIGHT)
    dot.textColor = level
    boxes.push(dot)
  }
  if (page.primaryHint) {
    boxes.push(text(6, 'primary-hint', page.primaryHint, 0, footerY, getTextWidth(page.primaryHint), LINE_HEIGHT))
  }
  if (page.scrollHint) {
    const width = getTextWidth(page.scrollHint)
    boxes.push(text(8, 'page-arrows', page.scrollHint, Math.floor((LENS_WIDTH - width) / 2), footerY, width, LINE_HEIGHT))
  }
  if (page.secondaryHint) {
    const width = getTextWidth(page.secondaryHint)
    boxes.push(text(7, 'secondary-hint', page.secondaryHint, LENS_WIDTH - width, footerY, width, LINE_HEIGHT))
  }
  if (page.menu) {
    const items = menuItems()
    const list = new ListContainerProperty({
      containerID: 5, containerName: 'actions', xPosition: BODY.x, yPosition: BODY.y,
      width: BODY.width, height: BODY.height, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length, itemName: items.map(item => item.label), isItemSelectBorderEn: 1,
      }),
    })
    return { containerTotalNum: boxes.length + 1, textObject: boxes, listObject: [list] }
  }
  if (page.orbit) return { containerTotalNum: boxes.length + 1, textObject: boxes, imageObject: [orbitContainer()] }
  boxes.push(text(1, 'body', page.body, BODY.x, BODY.y, BODY.width, BODY.height))
  return { containerTotalNum: boxes.length, textObject: boxes }
}

export const startupPage = (page: LensPage) => new CreateStartUpPageContainer(layout(page, 4))

export const lensPage = (page: LensPage, level: number) => new RebuildPageContainer(layout(page, level))

// EvenHub text containers accept up to 999 UTF-8 bytes, including on rebuild.
const MAX_TEXT_BYTES = 999
const utf8 = new TextEncoder()
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
// Space, hyphen and CJK are native word-wrap opportunities.
const breakable = /^[\s\-\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u

export function paginate(text: string): string[] {
  const value = text.replaceAll('\t', '    ')
  const segments = graphemes ? Array.from(graphemes.segment(value), part => part.segment) : Array.from(value)
  // An unusually long combining sequence can exceed a container on its own.
  const glyphs = segments.flatMap(segment => segment.length > MAX_TEXT_BYTES / 3 && utf8.encode(segment).length > MAX_TEXT_BYTES
    ? Array.from(segment) : segment)
  const pages: string[] = []
  let start = 0
  while (start < glyphs.length) {
    const slice = (end: number) => glyphs.slice(start, end).join('')
    let end = start + 1, limit = Math.min(start + MAX_TEXT_BYTES, glyphs.length)
    while (end < limit) {
      const mid = Math.ceil((end + limit) / 2)
      const candidate = slice(mid)
      if (utf8.encode(candidate).length <= MAX_TEXT_BYTES && measureTextWrap(candidate, BODY.width).height <= BODY.height) end = mid
      else limit = mid - 1
    }

    // Move a partial word to the next page if the bottom line already contains
    // other text. An unbroken URL or identifier can span a page by itself.
    if (end < glyphs.length && !breakable.test(glyphs[end]) && !breakable.test(glyphs[end - 1])) {
      let word = end
      while (word > start && !breakable.test(glyphs[word - 1])) word--
      if (word > start && measureTextWrap(slice(word).trimEnd(), BODY.width).height === BODY.height) end = word
    }
    pages.push(slice(end))
    // A hard newline at the boundary is already represented by the page turn.
    start = glyphs[end] === '\n' ? end + 1 : end
  }
  return pages.length ? pages : ['']
}
