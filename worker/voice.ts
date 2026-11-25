import { API_BASE_URL, MAX_WAV_BYTES } from '../src/config'
import { isPrivateAudioUrl } from '../src/api/private-audio'
import { isUuid } from '../src/types'
import { json } from './oauth'

/** The private bucket has no browser PUT CORS grant. Use only a URL issued
 * directly by Okou. The storage request never carries the user's bearer. */
export async function uploadVoice(request: Request): Promise<Response> {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'signed_out' }, 401)
  const size = Number(request.headers.get('content-length'))
  if (!Number.isSafeInteger(size) || size <= 44 || size > MAX_WAV_BYTES ||
      request.headers.get('content-type') !== 'audio/wav') return json({ error: 'invalid_wav' }, 400)
  const post = (path: string, body: object) => fetch(API_BASE_URL + path, {
    method: 'POST', redirect: 'manual', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const prepared = await post('/api/uploads/prepare/private', { filename: 'recording.wav', contentType: 'audio/wav', size })
  if (!prepared.ok) return json({ error: 'prepare_failed' }, prepared.status)
  const { id, uploadUrl, uploadHeaders } = await prepared.json() as {
    id: string; uploadUrl: string; uploadHeaders?: Record<string, string>
  }
  if (!isUuid(id) || !isPrivateAudioUrl(uploadUrl)) {
    return json({ error: 'invalid_upload_target' }, 502)
  }
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength !== size) return json({ error: 'incomplete_recording' }, 400)
  const headers = new Headers(uploadHeaders)
  headers.set('content-type', 'audio/wav')
  const uploaded = await fetch(uploadUrl, { method: 'PUT', redirect: 'manual', headers, body: bytes })
  if (!uploaded.ok) return json({ error: 'storage_upload_failed' }, 502)
  const completed = await post('/api/uploads/complete', { id })
  if (!completed.ok) return json({ error: 'complete_failed' }, completed.status)
  if ((await completed.json() as { id: string }).id !== id) return json({ error: 'invalid_upload_receipt' }, 502)
  return json({ id })
}
