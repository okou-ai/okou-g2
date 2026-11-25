import {
  CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty,
  RebuildPageContainer, TextContainerProperty, TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

export type LensMode = 'quiet' | 'reader' | 'voice'
export type Menu = 'reader' | 'voice'
export type Indicator = 'off' | 'unread' | 'working'
export interface LensPage {
  mode: LensMode
  menu: Menu | null
  body: string
  footer: string
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
const DOT_GLYPH = '•'
export function indicatorUpdate(level: number) {
  return new TextContainerUpgrade({ ...DOT, content: level ? DOT_GLYPH : ' ', textColor: level })
}

function layout(page: LensPage, level: number) {
  const title = text(2, 'title', 'Okou', 4, 0, 490, 34)
  const dot = text(DOT.containerID, DOT.containerName, page.indicator === 'off' || !level ? '' : DOT_GLYPH, 560, 0, 16, 34)
  dot.textColor = level
  if (page.menu) {
    const items = menuItems(page.menu)
    const list = new ListContainerProperty({
      containerID: 5, containerName: 'actions', xPosition: 4, yPosition: 36,
      width: 568, height: 248, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length, itemName: items.map(item => item.label), isItemSelectBorderEn: 1,
      }),
    })
    return { containerTotalNum: 3, textObject: [title, dot], listObject: [list] }
  }

  const boxes = [text(1, 'body', page.body, 4, 36, 568, page.mode === 'voice' ? 210 : 252)]
  if (page.mode !== 'quiet') boxes.push(title)
  boxes.push(dot)
  if (page.footer) boxes.push(text(4, 'voice-status', page.footer, 480, 253, 96, 35))
  return { containerTotalNum: boxes.length, textObject: boxes }
}

export const startupPage = () => new CreateStartUpPageContainer(layout({
  mode: 'quiet', menu: null, body: '', footer: '', indicator: 'off',
}, 4))

export const lensPage = (page: LensPage, level: number) => new RebuildPageContainer(layout(page, level))

/** Budget eight lines per page. The display wraps soft lines with its own font;
 * explicit line breaks in lists and code stay intact. */
export function paginate(text: string): string[] {
  const pages: string[] = []
  let page = '', lines = 1, width = 0
  const newLine = (explicit: boolean) => {
    if (lines === 8) {
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
    if (width + cells > 36) newLine(false)
    page += char === '\t' ? '    ' : char
    width += cells
  }
  if (page) pages.push(page)
  return pages.length ? pages : ['']
}
