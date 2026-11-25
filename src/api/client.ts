import { API_BASE_URL, MAX_WAV_BYTES } from '../config'
import { isUuid } from '../types'
import { isPrivateAudioUrl } from './private-audio'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super('Okou API returned ' + status + (code ? ' (' + code + ')' : ''))
  }
}

export type TokenProvider = () => Promise<string>

export class OkouApiClient {
  constructor(readonly getToken: TokenProvider, readonly signal: AbortSignal) {}

  async request<T>(path: string, body?: object, accessToken?: string): Promise<T> {
    const token = accessToken ?? await this.getToken()
    this.signal.throwIfAborted()
    const headers = new Headers({ authorization: 'Bearer ' + token })
    if (body) headers.set('content-type', 'application/json')
    const response = await fetch(API_BASE_URL + path, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: this.signal,
    }).catch((error: unknown) => {
      this.signal.throwIfAborted()
      if (error instanceof TypeError && typeof location !== 'undefined') {
        throw new Error('Could not reach api.okou.ai from ' + location.origin + '.', { cause: error })
      }
      throw error
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: { code?: string } } | null
      throw new ApiError(response.status, detail?.error?.code)
    }
    return response.json() as Promise<T>
  }

  async upload(audio: Blob): Promise<string> {
    if (audio.type !== 'audio/wav' || audio.size <= 44 || audio.size > MAX_WAV_BYTES) throw new Error('Invalid recording')
    const prepared = await this.request<{ id: string; uploadUrl: string; uploadHeaders?: Record<string, string> }>(
      '/api/uploads/prepare/private', { filename: 'recording.wav', contentType: audio.type, size: audio.size })
    if (!isUuid(prepared.id) || !isPrivateAudioUrl(prepared.uploadUrl)) throw new Error('Invalid private upload target')
    const headers = new Headers(prepared.uploadHeaders)
    headers.delete('authorization')
    headers.set('content-type', audio.type)
    const response = await fetch(prepared.uploadUrl, {
      method: 'PUT', headers, body: audio, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: this.signal,
    })
    if (!response.ok) throw new Error('Voice upload failed (' + response.status + ')')
    const completed = await this.request<{ id: string }>('/api/uploads/complete', { id: prepared.id })
    if (completed.id !== prepared.id) throw new Error('Invalid voice upload receipt')
    return prepared.id
  }
}
