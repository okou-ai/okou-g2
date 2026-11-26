import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, UnsecuredJWT } from 'jose'
import worker, { type Env } from '../../worker'
import { DEVICE_SCOPE, MCP_URL } from '../config'
import { rpc, toolResult } from './mcp-fixture'
const env: Env = { OAUTH_CLIENT_ID: 'fixture' }
const origin = 'https://g2.okou.ai'
const fileId = crypto.randomUUID()
const storage = 'https://user-artifact-private-prod.98b0b14cee451004596479a689d2071b.r2.cloudflarestorage.com/clip?signature=fixture'

function request(path: string, body: BodyInit = '{}', headers: Record<string, string> = {}) {
  return worker.fetch(new Request(origin + '/api/' + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body }), env)
}
const response = (body: unknown, status = 200) => Response.json(body, { status })
afterEach(() => vi.unstubAllGlobals())

it.each(['/', '/index.html', '/assets/index-abc123.js'])('retires the hosted client at %s', async (path) => {
  const retired = await worker.fetch(new Request(origin + path), env)
  expect(retired.status).toBe(410)
  expect(await retired.text()).toContain('Me → Beta tester → Okou → Install')
})

describe('device OAuth endpoints', () => {
  it('requests the device scopes with just the G2 public client ID', async () => {
    const post = vi.fn(async (_url: string, _init: RequestInit) => response({
      verification_uri: 'https://accounts.example.test/activate', user_code: 'TEST', device_code: 'test-code', expires_in: 90,
    }))
    vi.stubGlobal('fetch', post)
    expect((await request('auth/device')).status).toBe(200)
    expect(post.mock.calls[0][0]).toBe('https://clerk.okou.ai/oauth/device_authorization')
    expect(Object.fromEntries(post.mock.calls[0][1].body as URLSearchParams)).toEqual({ client_id: 'fixture', scope: DEVICE_SCOPE, resource: MCP_URL })
  })

  it('keeps refresh credentials in an HttpOnly cookie, rotates them and clears them on logout', async () => {
    const token = new UnsecuredJWT({ sub: 'user_a', org_id: 'org_a', client_id: 'fixture', aud: MCP_URL, scope: DEVICE_SCOPE })
      .setExpirationTime('1h').encode()
    const post = vi.fn(async (_url: string, _init: RequestInit) => response({}))
    post.mockResolvedValueOnce(response({ access_token: token, token_type: 'Bearer', refresh_token: 'test-only-first' }))
      .mockResolvedValueOnce(response({ access_token: token, token_type: 'Bearer', refresh_token: 'test-only-next' }))
    vi.stubGlobal('fetch', post)
    const issued = await request('auth/token', JSON.stringify({ device_code: 'code' }))
    const first = issued.headers.get('set-cookie')!
    expect(first).toContain('HttpOnly; SameSite=Strict')
    expect(first).toContain('Secure')
    expect(await issued.json()).toMatchObject({ userId: 'user_a', orgId: 'org_a', accessToken: token })
    const renewed = await request('auth/refresh', '{}', { cookie: first.split(';')[0] })
    const next = renewed.headers.get('set-cookie')!
    expect(next).toContain('test-only-next')
    expect(JSON.stringify(await renewed.json())).not.toContain('test-only')
    const revoked = await request('auth/logout', '{}', { cookie: next.split(';')[0] })
    expect(revoked.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((post.mock.calls[2][1].body as URLSearchParams).get('token')).toBe('test-only-next')
  })

  it('resumes a redeemed code from its own cookie without spending the code twice', async () => {
    const token = new UnsecuredJWT({ sub: 'user_a', org_id: 'org_a', client_id: 'fixture', aud: MCP_URL, scope: DEVICE_SCOPE })
      .setExpirationTime('1h').encode()
    const grant = { access_token: token, token_type: 'Bearer' }
    let redeemed = false
    const post = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as URLSearchParams
      if (form.get('refresh_token') === 'first-refresh') return response(grant)
      if (form.get('device_code') === 'another-code') return response({ error: 'authorization_pending' }, 400)
      if (redeemed) return response({ error: 'invalid_grant' }, 400)
      redeemed = true
      return response({ ...grant, refresh_token: 'first-refresh' })
    })
    vi.stubGlobal('fetch', post)
    const code = JSON.stringify({ device_code: 'original-device-code' })
    const issued = await request('auth/token', code)
    const cookie = issued.headers.get('set-cookie')!.split(';')[0]
    // A WebView can have received Set-Cookie without seeing the response body.
    const resumed = await request('auth/token', code, { cookie })
    expect(resumed.status).toBe(200)
    expect(await resumed.json()).toMatchObject({ userId: 'user_a', orgId: 'org_a' })
    expect(cookie).not.toContain('original-device-code')
    const renewedCookie = resumed.headers.get('set-cookie')!.split(';')[0]
    const other = await request('auth/token', JSON.stringify({ device_code: 'another-code' }), { cookie: renewedCookie })
    expect(await other.json()).toEqual({ error: 'authorization_pending' })
    const grants = post.mock.calls.map(([, init]) => Object.fromEntries(init.body as URLSearchParams))
    expect(grants).toEqual([
      { client_id: 'fixture', resource: MCP_URL, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'original-device-code' },
      { client_id: 'fixture', grant_type: 'refresh_token', refresh_token: 'first-refresh' },
      { client_id: 'fixture', resource: MCP_URL, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'another-code' },
    ])
  })

  it('refreshes existing untagged cookies as the original opaque token', async () => {
    const token = new UnsecuredJWT({ sub: 'user_a', org_id: 'org_a', client_id: 'fixture', aud: MCP_URL, scope: DEVICE_SCOPE })
      .setExpirationTime('1h').encode()
    const post = vi.fn(async (_url: string, _init: RequestInit) => response({ access_token: token, token_type: 'Bearer' }))
    vi.stubGlobal('fetch', post)
    const cookie = '__Host-g2-refresh-fixture=legacy%2Btoken'
    const restored = await request('auth/refresh', '{}', { cookie })
    expect(restored.status).toBe(200)
    expect((post.mock.calls[0][1].body as URLSearchParams).get('refresh_token')).toBe('legacy+token')
    expect(restored.headers.get('set-cookie')).toContain(cookie + ';')
  })

  it('rejects a grant that does not supply a workspace or names a different client', async () => {
    for (const fields of [{ client_id: 'fixture' }, { org_id: 'org_a', client_id: 'another-client' }]) {
      const token = await new SignJWT({ sub: 'user_a', ...fields }).setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h').sign(new Uint8Array(32))
      vi.stubGlobal('fetch', async () => response({ access_token: token, token_type: 'Bearer', refresh_token: 'fixture-only' }))
      expect((await request('auth/token', JSON.stringify({ device_code: 'code' }))).status).toBe(401)
    }
  })

  it('rejects cross-origin credential changes before calling Clerk', async () => {
    const post = vi.fn()
    vi.stubGlobal('fetch', post)
    expect((await request('auth/logout', '{}', { origin: 'https://other.example' })).status).toBe(403)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('private WAV upload', () => {
  const headers = { 'content-type': 'audio/wav', 'content-length': '48', authorization: 'Bearer fixture' }
  it('uses the bearer only at Okou and completes the exact prepared upload', async () => {
    const post = vi.fn(async (url: string, init: RequestInit) => {
      if (url === storage) return new Response(null, { status: 200 })
      expect(url).toBe(MCP_URL)
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture')
      const { name, arguments: args } = rpc(init).params
      if (name === 'prepare_voice_upload') {
        expect(args).toEqual({ filename: 'recording.wav', size: 48 })
        return toolResult(init, { id: fileId, uploadUrl: storage, uploadHeaders: { 'x-amz-meta-artifact-id': fileId } })
      }
      expect(name).toBe('complete_voice_upload')
      expect(args).toEqual({ id: fileId })
      return toolResult(init, { id: fileId })
    })
    vi.stubGlobal('fetch', post)
    const bytes = new Uint8Array(48)
    expect(await (await request('voice', bytes, headers)).json()).toEqual({ id: fileId })
    expect(post.mock.calls.map(([url]) => url)).toEqual([MCP_URL, storage, MCP_URL])
    const put = post.mock.calls[1][1]
    expect(put.method).toBe('PUT')
    expect(put.redirect).toBe('error')
    expect(new Headers(put.headers).get('authorization')).toBeNull()
    expect(new Headers(put.headers).get('x-amz-meta-artifact-id')).toBe(fileId)
    expect(new Uint8Array(await (put.body as Blob).arrayBuffer())).toEqual(bytes)
  })
  it('stops before uploading audio to an unexpected destination', async () => {
    const post = vi.fn(async (_url: string, init: RequestInit) => toolResult(init, { id: fileId, uploadUrl: 'https://elsewhere.example/clip' }))
    vi.stubGlobal('fetch', post)
    expect((await request('voice', new Uint8Array(48), headers)).status).toBe(502)
    expect(post).toHaveBeenCalledTimes(1)
  })
})
