import { ImageContainerProperty, ImageRawDataUpdate } from '@evenrealities/even_hub_sdk'

const IMAGE = { containerID: 9, containerName: 'standby' }
const HEIGHT = 20
const WORK_WIDTH = 28
const UNREAD_WIDTH = 20
const PERIOD_MS = 2000
export const FRAME_MS = 125

export function standbyContainer(unread: boolean) {
  return new ImageContainerProperty({
    ...IMAGE, xPosition: 4, yPosition: 4, height: HEIGHT, width: unread ? UNREAD_WIDTH : WORK_WIDTH,
  })
}

// Black Gray8 pixels are off. The glasses tint the lit pixels green.
function dots(width: number, diameter: number, tops: number[], brightness: number) {
  const pixels = new Uint8Array(width * HEIGHT)
  const radius = diameter / 2
  for (const [i, top] of tops.entries()) {
    const left = i * (diameter + 5)
    for (let y = 0; y < diameter; y++) {
      for (let x = 0; x < diameter; x++) {
        const distance = Math.hypot(x + 0.5 - radius, y + 0.5 - radius)
        const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance))
        pixels[(top + y) * width + left + x] = Math.round(brightness * coverage)
      }
    }
  }
  return new ImageRawDataUpdate({ ...IMAGE, imageData: pixels })
}

export const unreadDot = dots(UNREAD_WIDTH, 16, [2], 255)

const wave = Array.from({ length: PERIOD_MS / FRAME_MS }, (_, frame) => {
  const ms = frame * FRAME_MS
  const tops = [0, 220, 440].map(delay => {
    const t = ms - delay
    const progress = Math.max(0, Math.min(t / 360, (740 - t) / 380))
    const lift = 3 * (1 - Math.cos(Math.PI * progress))
    return 8 - Math.round(lift)
  })
  // Fade the three dots together, with one dark beat between waves.
  const opacity = Math.min(1, Math.max(0, (1680 - ms) / 320, (ms - 1820) / 180))
  return dots(WORK_WIDTH, 6, tops, 255 * opacity)
})

export function workingDots(elapsedMs: number) {
  return wave[Math.floor(elapsedMs / FRAME_MS) % wave.length]
}
