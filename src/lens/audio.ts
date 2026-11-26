import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
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
  readonly recording: RecordedVoice
  stop(): Promise<RecordedVoice | null>
  cancel(): Promise<void>
}

export async function startRecording(bridge: EvenAppBridge, onStorageFailure: () => void): Promise<Recorder> {
  const recording = new RecordedVoice()
  let buffer = new Uint8Array(PCM_SEGMENT_BYTES)
  let used = 0
  const unsubscribe = bridge.onEvenHubEvent(event => {
    const bytes = toBytes(event.audioEvent?.audioPcm)
    if (!bytes) return
    for (let offset = 0; offset < bytes.length;) {
      const count = Math.min(buffer.length - used, bytes.length - offset)
      buffer.set(bytes.subarray(offset, offset + count), used)
      used += count
      offset += count
      if (used === buffer.length) {
        recording.saveSegment(buffer.buffer, onStorageFailure)
        buffer = new Uint8Array(PCM_SEGMENT_BYTES)
        used = 0
      }
    }
  })
  try {
    if (!await bridge.audioControl(true, AudioInputSource.Glasses)) throw new Error('The glasses microphone did not start')
  } catch (error) {
    unsubscribe()
    await recording.discard()
    throw error
  }

  const closeMic = async () => {
    unsubscribe()
    if (!await bridge.audioControl(false)) throw new Error('Could not close the microphone')
  }
  return {
    recording,
    async stop() {
      try {
        await closeMic()
        await recording.finish(buffer.buffer.slice(0, used - used % 2))
        if (recording.fileCount) return recording
      } catch (error) {
        await recording.discard()
        throw error
      }
      return null
    },
    async cancel() {
      try { await closeMic() }
      finally { await recording.discard() }
    },
  }
}
