/** Keep the contents of code blocks and inline code verbatim on the text lens. */
export function markdownToPlainText(markdown: string): string {
  let fence = ''
  return markdown.replace(/\r\n?/gu, '\n').split('\n').flatMap((line) => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker && !fence) { fence = marker; return [] }
    if (fence) {
      if (marker?.startsWith(fence)) { fence = ''; return [] }
      return [line]
    }
    return [line.replace(/^\s{0,3}(?:#{1,6}|>)\s+/u, '')
      .replace(/^\s*[-*+]\s+/u, '• ')
      .split(/(`[^`]*`)/gu).map((part) => part.startsWith('`') && part.endsWith('`') ? part.slice(1, -1)
        : part.replace(/!?\[([^\]]*)\]\([^)]+\)/gu, '$1')
          .replace(/\*\*(.+?)\*\*|__(.+?)__/gu, (_match, a, b) => a ?? b)).join('')]
  }).join('\n').trim()
}
