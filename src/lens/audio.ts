import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { AUDIO_SAMPLE_RATE } from '../config'
import { PCM_SEGMENT_BYTES, RecordedVoice } from './recording'

/** Normalize the several shapes a host may use for the PCM payload. */
function toBytes(pcm: unknown): Uint8Array | null {
  if (pcm instanceof Uint8Array) return pcm
  if (Array.isArray(pcm)) return Uint8Array.from(pcm as number[])
  if (typeof pcm === 'string') {
    const binary = atob(pcm)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  return null
}

export interface Recorder {
  readonly seconds: number
  stop(): Promise<RecordedVoice | null>
  cancel(): Promise<void>
}

export async function startRecording(bridge: EvenAppBridge, onSecond?: () => void): Promise<Recorder> {
  const recording = new RecordedVoice()
  let buffer = new Uint8Array(PCM_SEGMENT_BYTES)
  let used = 0
  let totalBytes = 0
  let seconds = 0
  const unsubscribe = bridge.onEvenHubEvent(event => {
    const bytes = toBytes(event.audioEvent?.audioPcm)
    if (!bytes) return
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(buffer.length - used, bytes.length - offset)
      buffer.set(bytes.subarray(offset, offset + count), used)
      used += count
      offset += count
      if (used === buffer.length) {
        recording.append(buffer.buffer)
        buffer = new Uint8Array(PCM_SEGMENT_BYTES)
        used = 0
      }
    }
    totalBytes += bytes.length
    const elapsed = Math.floor(totalBytes / (2 * AUDIO_SAMPLE_RATE))
    if (elapsed !== seconds) {
      seconds = elapsed
      onSecond?.()
    }
  })
  try {
    if (!await bridge.audioControl(true, AudioInputSource.Glasses)) throw new Error('The glasses microphone did not start')
  } catch (error) {
    unsubscribe()
    throw error
  }

  const closeMic = async () => {
    unsubscribe()
    if (!await bridge.audioControl(false)) throw new Error('Could not close the microphone')
  }
  return {
    get seconds() { return seconds },
    async stop() {
      await closeMic()
      recording.append(buffer.buffer.slice(0, used - used % 2))
      return recording.fileCount ? recording : null
    },
    cancel: closeMic,
  }
}
