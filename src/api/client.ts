import { API_BASE_URL } from '../config'
import { isUuid } from '../types'

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
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: { code?: string } } | null
      throw new ApiError(response.status, detail?.error?.code)
    }
    return response.json() as Promise<T>
  }

  async upload(audio: Blob): Promise<string> {
    const token = await this.getToken()
    const response = await fetch('/api/voice', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'audio/wav' },
      body: audio, credentials: 'omit', redirect: 'error', signal: this.signal,
    })
    if (!response.ok) throw new Error('Voice upload failed (' + response.status + ')')
    const result = await response.json() as { id?: unknown }
    if (!isUuid(result.id)) throw new Error('Invalid voice upload receipt')
    return result.id
  }
}
