import { decodeJwt } from 'jose'
import { DEVICE_SCOPE, OAUTH_ISSUER } from '../src/config'
import type { DeviceCode, DeviceSession } from '../src/types'

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

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

function parseSession(body: Record<string, unknown>, clientId: string): DeviceSession {
  if (typeof body.access_token !== 'string' || String(body.token_type).toLowerCase() !== 'bearer') {
    throw new Error('Invalid access token')
  }
  // Read only the fresh token returned by the issuer over HTTPS. Okou API
  // performs signature, audience, scope and workspace membership checks.
  const { sub, org_id, exp, client_id } = decodeJwt(body.access_token)
  if (client_id !== clientId || !sub?.startsWith('user_') ||
      typeof org_id !== 'string' || !org_id.startsWith('org_') ||
      typeof exp !== 'number' || exp * 1000 <= Date.now()) {
    throw new Error('Authorize again and select a workspace')
  }
  return { accessToken: body.access_token, userId: sub, orgId: org_id, expiresAt: exp * 1000 }
}

export async function auth(request: Request, action: string, clientId: string): Promise<Response> {
  if (!/^[a-z\d_-]+$/iu.test(clientId || '')) return json({ error: 'device_client_not_configured' }, 503)
  const name = '__Host-g2-refresh-' + clientId
  const cookie = (token: string) => name + '=' + encodeURIComponent(token) +
    '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + (token ? 60 * 60 * 24 * 90 : 0)
  const saved = (request.headers.get('cookie') ?? '').split(';').map((v) => v.trim())
    .find((v) => v.startsWith(name + '='))
  const refresh = saved ? decodeURIComponent(saved.slice(name.length + 1)) : ''

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
    const d = await response.json() as DeviceCode
    const url = new URL(d.verification_uri)
    const interval = d.interval ?? 5
    if (!d.device_code || !d.user_code || url.protocol !== 'https:' || url.username || url.password ||
        !Number.isSafeInteger(d.expires_in) || d.expires_in <= 0 ||
        !Number.isSafeInteger(interval) || interval <= 0) return json({ error: 'invalid_device_code' }, 502)
    return json({ device_code: d.device_code, user_code: d.user_code, verification_uri: url.href,
      expires_in: d.expires_in, interval })
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
    params = { grant_type: DEVICE_GRANT, device_code: input.device_code }
  } else return json({ error: 'not_found' }, 404)

  const result = await clerk('/oauth/token', { ...params, client_id: clientId })
  const body = await result.json() as Record<string, unknown>
  if (!result.ok) {
    const known = ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant']
    const code = typeof body.error === 'string' && known.includes(body.error) ? body.error : 'token_request_failed'
    if (action === 'refresh' && ['invalid_grant', 'access_denied', 'expired_token'].includes(code)) {
      return json({ error: 'signed_out' }, 401, cookie(''))
    }
    return json({ error: code }, result.status >= 500 ? 502 : 400)
  }
  let session: DeviceSession
  try {
    session = parseSession(body, clientId)
  } catch {
    return json({ error: 'workspace_grant_required' }, 401, cookie(''))
  }
  const next = body.refresh_token ?? (action === 'refresh' ? refresh : null)
  if (typeof next !== 'string' || !next) return json({ error: 'offline_grant_required' }, 401, cookie(''))
  return json(session, 200, cookie(next))
}
