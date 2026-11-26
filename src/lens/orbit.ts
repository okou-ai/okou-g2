import { ImageContainerProperty, ImageRawDataUpdate } from '@evenrealities/even_hub_sdk'
import sheetUrl from './assets/orbit.png'
import { LENS_HEIGHT, LENS_WIDTH } from './display'

// The sprite holds the Okou Zero orbit in lens gray levels. The brightest
// shade is reserved for the moving star. Send only the rectangle containing it.
const COLUMNS = 10
const FRAMES = 60
const PERIOD_MS = 7400
const WIDTH = 234
const HEIGHT = 110
const IMAGE = { containerID: 10, containerName: 'orbit' }

export function orbitContainer() {
  return new ImageContainerProperty({
    ...IMAGE, width: WIDTH, height: HEIGHT,
    xPosition: (LENS_WIDTH - WIDTH) / 2, yPosition: (LENS_HEIGHT - HEIGHT) / 2 + 3,
  })
}

let frames: Promise<ImageRawDataUpdate[]> | undefined

async function decodeFrames() {
  const sheet = new Image()
  sheet.src = sheetUrl
  await sheet.decode()
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not draw the G2 orbit')
  ctx.imageSmoothingEnabled = false
  const tileWidth = sheet.naturalWidth / COLUMNS
  const tileHeight = sheet.naturalHeight / (FRAMES / COLUMNS)
  return Array.from({ length: FRAMES }, (_, i) => {
    const x = (i % COLUMNS) * tileWidth, y = Math.floor(i / COLUMNS) * tileHeight
    ctx.drawImage(sheet, x, y, tileWidth, tileHeight, 0, 0, WIDTH, HEIGHT)
    const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data
    // The SDK accepts packed Gray4, with the left pixel in the high nibble.
    const pixels = new Uint8Array(WIDTH * HEIGHT / 2)
    for (let p = 0; p < pixels.length; p++) {
      pixels[p] = (rgba[p * 8] & 0xf0) | (rgba[p * 8 + 4] >> 4)
    }
    return new ImageRawDataUpdate({ ...IMAGE, imageData: pixels })
  })
}

export async function orbitFrame(elapsedMs: number) {
  frames ??= decodeFrames().catch(error => { frames = undefined; throw error })
  return (await frames)[Math.floor(elapsedMs % PERIOD_MS * FRAMES / PERIOD_MS)]
}
