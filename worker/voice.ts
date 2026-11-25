import { MAX_WAV_BYTES } from '../src/config'
import { OkouApiClient, VoiceUploadError } from '../src/api/client'
import { json } from './oauth'

export async function uploadVoice(request: Request): Promise<Response> {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'signed_out' }, 401)
  const size = Number(request.headers.get('content-length'))
  if (!Number.isSafeInteger(size) || size <= 44 || size > MAX_WAV_BYTES ||
      request.headers.get('content-type') !== 'audio/wav') return json({ error: 'invalid_wav' }, 400)
  const audio = await request.blob()
  if (audio.size !== size) return json({ error: 'incomplete_recording' }, 400)
  const api = new OkouApiClient(async () => authorization.slice('Bearer '.length), request.signal)
  try { return json({ id: await api.upload(audio) }) }
  catch (error) {
    if (error instanceof VoiceUploadError) return json({ error: error.code }, error.status)
    throw error
  }
}
