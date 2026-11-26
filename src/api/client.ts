import { version } from '../../app.json'
import { MAX_WAV_BYTES, MCP_URL } from '../config'
import { isUuid } from '../types'
import { isPrivateAudioUrl } from './private-audio'

const protocol = '2026-07-28'
const clientMeta = {
  'io.modelcontextprotocol/protocolVersion': protocol,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'okou-g2', version },
}

type Tool = 'create_chat_thread' | 'get_chat_messages' | 'get_chat_realtime_token' | 'send_chat_message' |
  'revoke_queued_message' | 'cancel_run' | 'prepare_voice_upload' | 'complete_voice_upload'

const uploadStatus: Readonly<Record<string, number | undefined>> = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
}

export class ApiError extends Error {
  constructor(tool: Tool, readonly status: number | null, readonly code?: string) {
    super('Okou MCP ' + tool + (status ? ' returned HTTP ' + status : ' failed') + (code ? ' (' + code + ')' : ''))
  }

  get missingThread() { return this.status === null && (this.code === 'NOT_FOUND' || this.code === 'CHAT_THREAD_NOT_FOUND') }

  get rejected() {
    if (this.status !== null) return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 409 && this.status !== 429
    return ['BAD_REQUEST', 'INVALID_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CHAT_THREAD_NOT_FOUND'].includes(this.code ?? '')
  }
}

export class VoiceUploadError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message) }
}

export type TokenProvider = () => Promise<string>

type ToolReply<T> = {
  jsonrpc: string
  id: string
  error?: { code: number }
  result?: { isError?: boolean; structuredContent?: T & { error?: { code?: string } } }
}

export class OkouApiClient {
  constructor(readonly getToken: TokenProvider, readonly signal: AbortSignal) {}

  async call<T>(tool: Tool, args: object, accessToken?: string): Promise<T> {
    const token = accessToken ?? await this.getToken()
    this.signal.throwIfAborted()
    const id = crypto.randomUUID()
    const response = await fetch(MCP_URL, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: this.signal,
      headers: {
        authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        'mcp-protocol-version': protocol, 'mcp-method': 'tools/call', 'mcp-name': tool,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args, _meta: clientMeta } }),
    }).catch((error: unknown) => {
      this.signal.throwIfAborted()
      if (error instanceof TypeError && typeof location !== 'undefined') {
        throw new Error(tool + ' could not reach api.okou.ai/mcp from ' + location.origin + '.', { cause: error })
      }
      throw error
    })
    if (!response.ok) throw new ApiError(tool, response.status)
    // Okou's stateless tools return a single JSON-RPC result with structured content.
    const reply = await response.json() as ToolReply<T>
    if (reply.jsonrpc !== '2.0' || reply.id !== id) throw new Error('Invalid MCP response')
    if (reply.error) throw new Error('Okou MCP rejected ' + tool + ' (' + reply.error.code + ')')
    if (reply.result?.isError) throw new ApiError(tool, null, reply.result.structuredContent?.error?.code)
    const body = reply.result?.structuredContent
    if (!body || typeof body !== 'object') throw new Error('Missing MCP tool result')
    return body
  }

  private async uploadTool<T>(tool: 'prepare_voice_upload' | 'complete_voice_upload', args: object): Promise<T> {
    try { return await this.call<T>(tool, args) }
    catch (error) {
      this.signal.throwIfAborted()
      const status = error instanceof ApiError ? error.status ?? uploadStatus[error.code ?? ''] : undefined
      throw new VoiceUploadError(tool === 'prepare_voice_upload' ? 'prepare_failed' : 'complete_failed', status ?? 502,
        error instanceof Error ? error.message : 'Voice upload failed')
    }
  }

  async upload(audio: Blob): Promise<string> {
    if (audio.type !== 'audio/wav' || audio.size <= 44 || audio.size > MAX_WAV_BYTES) throw new VoiceUploadError('invalid_wav', 400, 'Invalid recording')
    const prepared = await this.uploadTool<{ id: string; uploadUrl: string; uploadHeaders?: Record<string, string> }>(
      'prepare_voice_upload', { filename: 'recording.wav', size: audio.size })
    if (!isUuid(prepared.id) || !isPrivateAudioUrl(prepared.uploadUrl)) throw new VoiceUploadError('invalid_upload_target', 502, 'Invalid private upload target')
    const headers = new Headers(prepared.uploadHeaders)
    headers.delete('authorization')
    headers.set('content-type', audio.type)
    const response = await fetch(prepared.uploadUrl, {
      method: 'PUT', headers: Object.fromEntries(headers), body: audio, credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: this.signal,
    }).catch(() => {
      this.signal.throwIfAborted()
      throw new VoiceUploadError('storage_upload_failed', 502, 'Could not upload the recording to R2.')
    })
    if (!response.ok) throw new VoiceUploadError('storage_upload_failed', 502, 'R2 recording upload returned HTTP ' + response.status + '.')
    const completed = await this.uploadTool<{ id: string }>('complete_voice_upload', { id: prepared.id })
    if (completed.id !== prepared.id) throw new VoiceUploadError('invalid_upload_receipt', 502, 'Invalid voice upload receipt')
    return prepared.id
  }
}
