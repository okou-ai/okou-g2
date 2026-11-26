import { AUDIO_SAMPLE_RATE, MAX_WAV_BYTES } from '../config'

const WAV_HEADER = 44
export const PCM_SEGMENT_BYTES = AUDIO_SAMPLE_RATE * 2 * 15
// One voice part is transcribed in one request, whose total audio limit is 25 MiB.
const SEGMENTS_PER_FILE = Math.floor((MAX_WAV_BYTES - WAV_HEADER) / PCM_SEGMENT_BYTES)

function wav(parts: Blob[]): Blob {
  const size = parts.reduce((sum, part) => sum + part.size, 0)
  const header = new ArrayBuffer(WAV_HEADER)
  const view = new DataView(header)
  const tag = (at: number, word: string) => {
    for (let i = 0; i < word.length; i++) view.setUint8(at + i, word.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + size, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM format header length
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // Mono
  view.setUint32(24, AUDIO_SAMPLE_RATE, true)
  view.setUint32(28, AUDIO_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true) // Bytes per frame
  view.setUint16(34, 16, true) // Bits per sample
  tag(36, 'data')
  view.setUint32(40, size, true)
  return new Blob([header, ...parts], { type: 'audio/wav' })
}

export class RecordedVoice {
  readonly clientEventId = crypto.randomUUID()
  private readonly segments: Blob[] = []

  append(pcm: ArrayBuffer) {
    if (pcm.byteLength) this.segments.push(new Blob([pcm]))
  }

  get fileCount() { return Math.ceil(this.segments.length / SEGMENTS_PER_FILE) }

  file(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.fileCount) throw new Error('Missing recording')
    const first = index * SEGMENTS_PER_FILE
    return wav(this.segments.slice(first, first + SEGMENTS_PER_FILE))
  }
}
