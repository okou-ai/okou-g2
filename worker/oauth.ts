import { DEVICE_SCOPE, OAUTH_ISSUER } from '../src/config'
import { DEVICE_GRANT, deviceCodeHash, parseDeviceCode, parseSession } from '../src/device-protocol'
import type { DeviceCode, DeviceSession } from '../src/types'

export function json(data: unknown, status = 200, cookie?: string) {
  const headers = new Headers({ 'cache-control': 'no-store' })
  if (cookie) headers.set('set-cookie', cookie)
  return Response.json(data, { status, headers })
}

function clerk(path: string, params: Record<string, string>) {
  return fetch(OAUTH_ISSUER + path, {
    method: 'POST',
    body: new URLSearchParams(params),
    redirect: 'manual',
  })
}

export async function auth(request: Request, action: string, clientId: string): Promise<Response> {
  if (!/^[a-z\d_-]+$/iu.test(clientId || '')) return json({ error: 'device_client_not_configured' }, 503)
  const name = '__Host-g2-refresh-' + clientId
  const cookie = (token: string) => name + '=' + encodeURIComponent(token) +
    '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + (token ? 60 * 60 * 24 * 90 : 0)
  const saved = (request.headers.get('cookie') ?? '').split(';').map((v) => v.trim())
    .find((v) => v.startsWith(name + '='))
  const stored = saved ? decodeURIComponent(saved.slice(name.length + 1)) : ''
  // Previously issued cookies hold the opaque refresh token on its own.
  const receipt = /^g2v1:([0-9a-f]{64}):(.+)$/u.exec(stored)
  const refresh = receipt?.[2] ?? stored
  let grantHash = receipt?.[1]

  if (action === 'logout') {
    // Local sign-out also succeeds if the issuer is temporarily unavailable.
    if (refresh) await clerk('/oauth/token/revoke', {
      client_id: clientId, token: refresh, token_type_hint: 'refresh_token',
    }).catch(() => undefined)
    return json({}, 200, cookie(''))
  }
  if (action === 'device') {
    const response = await clerk('/oauth/device_authorization', { client_id: clientId, scope: DEVICE_SCOPE })
    if (!response.ok) return json({ error: 'device_authorization_failed' }, 502)
    try {
      return json(parseDeviceCode(await response.json() as DeviceCode))
    } catch {
      return json({ error: 'invalid_device_code' }, 502)
    }
  }
  let params: Record<string, string>
  if (action === 'refresh') {
    if (!refresh) return json({ error: 'signed_out' }, 401)
    params = { grant_type: 'refresh_token', refresh_token: refresh }
  } else if (action === 'token') {
    const input = await request.json() as { device_code?: unknown }
    if (typeof input?.device_code !== 'string' || !input.device_code || input.device_code.length > 4096) {
      return json({ error: 'invalid_device_code' }, 400)
    }
    grantHash = await deviceCodeHash(input.device_code)
    // A resumed WebView may have the cookie even when it lost the success
    // response. Redeeming that one-time code again can revoke the issued grant.
    params = grantHash === receipt?.[1]
      ? { grant_type: 'refresh_token', refresh_token: refresh }
      : { grant_type: DEVICE_GRANT, device_code: input.device_code }
  } else return json({ error: 'not_found' }, 404)

  const result = await clerk('/oauth/token', { ...params, client_id: clientId })
  const body = await result.json() as Record<string, unknown>
  const refreshing = params.grant_type === 'refresh_token'
  if (!result.ok) {
    const known = ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant']
    const code = typeof body.error === 'string' && known.includes(body.error) ? body.error : 'token_request_failed'
    if (refreshing && ['invalid_grant', 'access_denied', 'expired_token'].includes(code)) {
      return json({ error: action === 'refresh' ? 'signed_out' : 'invalid_grant' }, 401, cookie(''))
    }
    return json({ error: code }, result.status >= 500 ? 502 : 400)
  }
  let session: DeviceSession
  try {
    session = parseSession(body, clientId)
  } catch {
    return json({ error: 'workspace_grant_required' }, 401, cookie(''))
  }
  const next = body.refresh_token ?? (refreshing ? refresh : null)
  if (typeof next !== 'string' || !next) return json({ error: 'offline_grant_required' }, 401, cookie(''))
  return json(session, 200, cookie(grantHash ? 'g2v1:' + grantHash + ':' + next : next))
}
