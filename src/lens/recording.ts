import { createStore, getMany, keys, promisifyRequest, set } from 'idb-keyval'
import { AUDIO_SAMPLE_RATE, MAX_WAV_BYTES } from '../config'

const store = createStore('okou-g2-voice-drafts', 'pcm')
const WAV_HEADER = 44
export const PCM_SEGMENT_BYTES = AUDIO_SAMPLE_RATE * 2 * 15
// One voice part is transcribed in one request, whose total audio limit is 25 MiB.
const SEGMENTS_PER_FILE = Math.floor((MAX_WAV_BYTES - WAV_HEADER) / PCM_SEGMENT_BYTES)

function erase(id: string) {
  return store('readwrite', objectStore => {
    objectStore.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
    return promisifyRequest(objectStore.transaction)
  })
}

// Each active draft holds its lock through send/retry or discard. After an
// unexpected WebView exit, the next recording can reclaim its orphaned bytes.
let swept = false
function holdDraft(id: string): Promise<() => void> {
  const locks = navigator.locks
  if (!locks) return Promise.resolve(() => {})
  return new Promise((resolve, reject) => {
    void locks.request(id, () => new Promise<void>(release => {
      resolve(release)
      if (swept) return
      swept = true
      void keys<[string, number]>(store).then(async stored => {
        for (const previous of new Set(stored.map(([name]) => name))) {
          if (!previous.startsWith('okou.g2.pcm.') || previous === id) continue
          await locks.request(previous, { ifAvailable: true }, lock => lock ? erase(previous) : undefined)
        }
      }).catch(() => { swept = false })
    })).catch(reject)
  })
}

// A WebView may close and later assign the same loopback origin to a different
// installation. The per-take key lives only in memory; segment indexes never
// repeat for that key.
function cipher(index: number) {
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setBigUint64(4, BigInt(index))
  return { name: 'AES-GCM', iv }
}

function wav(parts: ArrayBuffer[]): Blob {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0)
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
  private readonly id = (navigator.locks ? 'okou.g2.pcm.' : 'pcm.') + crypto.randomUUID()
  private lock?: Promise<() => void>
  private key?: CryptoKey
  private writes = Promise.resolve()
  private readonly inMemory = new Map<number, ArrayBuffer>()
  private count = 0
  storageFailed = false

  /** Takes ownership of a full PCM buffer. Short recordings never open the database. */
  saveSegment(pcm: ArrayBuffer, onFailure: () => void) {
    const index = this.count++
    this.lock ??= holdDraft(this.id)
    this.writes = this.writes.then(async () => {
      try {
        await this.lock
        this.key ??= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        const sealed = await crypto.subtle.encrypt(cipher(index), this.key, pcm)
        await set([this.id, index], sealed, store)
      } catch {
        // Stop capture visibly, keeping even the segment that exhausted disk space.
        this.inMemory.set(index, pcm)
        if (!this.storageFailed) {
          this.storageFailed = true
          onFailure()
        }
      }
    })
  }

  finish(tail: ArrayBuffer) {
    if (tail.byteLength) this.inMemory.set(this.count++, tail)
    return this.writes
  }

  get fileCount() { return Math.ceil(this.count / SEGMENTS_PER_FILE) }

  async file(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.fileCount) throw new Error('Missing recording')
    const first = index * SEGMENTS_PER_FILE
    const indexes = Array.from({ length: Math.min(this.count - first, SEGMENTS_PER_FILE) }, (_, n) => first + n)
    const onDisk = indexes.filter(n => !this.inMemory.has(n))
    const saved = onDisk.length ? await getMany<ArrayBuffer>(onDisk.map(n => [this.id, n]), store) : []
    let cursor = 0
    const parts: ArrayBuffer[] = []
    for (const n of indexes) {
      const local = this.inMemory.get(n)
      if (local) {
        parts.push(local)
      } else {
        const sealed = saved[cursor++]
        if (!sealed || !this.key) throw new Error('A saved audio segment is unavailable')
        parts.push(await crypto.subtle.decrypt(cipher(n), this.key, sealed))
      }
    }
    return wav(parts)
  }

  async discard() {
    await this.writes
    this.inMemory.clear()
    this.key = undefined
    this.count = 0
    if (this.lock) {
      try { await erase(this.id) }
      finally { (await this.lock)() }
    }
  }
}
