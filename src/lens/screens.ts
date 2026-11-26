import {
  CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty,
  RebuildPageContainer, TextContainerProperty, TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { LENS_HEIGHT, LENS_WIDTH, LINE_CELLS, PAGE_LINES } from './display'

export type LensMode = 'quiet' | 'reader' | 'voice'
export type Menu = 'reader' | 'voice'
export type Indicator = 'off' | 'unread' | 'working'
export interface LensPage {
  mode: LensMode
  menu: Menu | null
  body: string
  status: string
  primaryHint: string
  secondaryHint: string
  indicator: Indicator
}

const actions = {
  reader: ['cancel', 'launcher', 'back'],
  voice: ['send', 'discard'],
} as const
const labels = {
  cancel: ['Cancel current task', '取消当前任务'],
  launcher: ['Back to main menu', '返回主菜单'],
  back: ['Back to Okou', '回到 Okou'],
  send: ['Send now', '立即发送'],
  discard: ['Discard message', '放弃当前消息'],
} as const

export function menuItems(menu: Menu) {
  const language = globalThis.navigator?.language?.startsWith('zh') ? 1 : 0
  return actions[menu].map(action => ({ action, label: labels[action][language] }))
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
  const lineHeight = 27
  const footerY = LENS_HEIGHT - lineHeight
  if (page.mode !== 'quiet') boxes.push(text(2, 'title', 'OKOU', 0, 0, getTextWidth('OKOU'), lineHeight))
  if (page.status) {
    const width = getTextWidth(page.status)
    const status = text(VOICE.containerID, VOICE.containerName, page.status, LENS_WIDTH - width, 0, width, lineHeight)
    status.textColor = level
    boxes.push(status)
  } else {
    const width = getTextWidth(DOT_GLYPH)
    const dot = text(DOT.containerID, DOT.containerName, page.indicator === 'off' ? '' : DOT_GLYPH, LENS_WIDTH - width, 0, width, lineHeight)
    dot.textColor = level
    boxes.push(dot)
  }
  if (page.primaryHint) {
    boxes.push(text(6, 'primary-hint', page.primaryHint, 0, footerY, getTextWidth(page.primaryHint), lineHeight))
  }
  if (page.secondaryHint) {
    const width = getTextWidth(page.secondaryHint)
    boxes.push(text(7, 'secondary-hint', page.secondaryHint, LENS_WIDTH - width, footerY, width, lineHeight))
  }
  if (page.menu) {
    const items = menuItems(page.menu)
    const list = new ListContainerProperty({
      containerID: 5, containerName: 'actions', xPosition: 4, yPosition: 36,
      width: 568, height: 214, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length, itemName: items.map(item => item.label), isItemSelectBorderEn: 1,
      }),
    })
    return { containerTotalNum: boxes.length + 1, textObject: boxes, listObject: [list] }
  }
  boxes.push(text(1, 'body', page.body, 4, 36, 568, 214))
  return { containerTotalNum: boxes.length, textObject: boxes }
}

export const startupPage = () => new CreateStartUpPageContainer(layout({
  mode: 'quiet', menu: null, body: '', status: '', primaryHint: '', secondaryHint: '', indicator: 'off',
}, 4))

export const lensPage = (page: LensPage, level: number) => new RebuildPageContainer(layout(page, level))

/** Budget seven lines per page. The display wraps soft lines with its own font;
 * explicit line breaks in lists and code stay intact. */
export function paginate(text: string): string[] {
  const pages: string[] = []
  let page = '', lines = 1, width = 0
  const newLine = (explicit: boolean) => {
    if (lines === PAGE_LINES) {
      pages.push(page)
      page = ''
      lines = 1
    } else {
      if (explicit) page += '\n'
      lines++
    }
    width = 0
  }
  const segments = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment)
    : Array.from(text)
  for (const char of segments) {
    if (char === '\n') { newLine(true); continue }
    const cells = char === '\t' ? 4 : char.codePointAt(0)! >= 0x1100 ? 2 : 1
    if (width + cells > LINE_CELLS) newLine(false)
    page += char === '\t' ? '    ' : char
    width += cells
  }
  if (page) pages.push(page)
  return pages.length ? pages : ['']
}
