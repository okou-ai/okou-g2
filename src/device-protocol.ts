import { decodeJwt, type JWTPayload } from 'jose'
import { CANCEL_SCOPE, CHAT_SCOPES, MCP_URL } from './config'
import type { DeviceAuthorizationResponse, DeviceCode, DeviceSession } from './types'

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export function parseDeviceCode(data: DeviceAuthorizationResponse): DeviceCode {
  const url = new URL(data.verification_uri)
  const link = new URL(data.verification_uri_complete ?? url.href)
  const interval = data.interval ?? 5
  if (typeof data.device_code !== 'string' || !data.device_code ||
      typeof data.user_code !== 'string' || !data.user_code || url.protocol !== 'https:' ||
      url.username || url.password || link.protocol !== 'https:' || link.origin !== url.origin || link.username || link.password ||
      !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 ||
      !Number.isSafeInteger(interval) || interval <= 0) throw new Error('Invalid device code')
  if (!data.verification_uri_complete) link.searchParams.set('user_code', data.user_code)
  return { device_code: data.device_code, user_code: data.user_code, verification_uri: url.href,
    verification_uri_complete: link.href, expires_in: data.expires_in, interval }
}

export const MCP_GRANT_PROMPT = 'Sign in again to authorize this device for Okou chat.'
export class McpConsentRequired extends Error {}

function tokenScopes({ scope, scp }: JWTPayload): readonly unknown[] {
  if (Array.isArray(scp)) return scp
  return typeof scope === 'string' ? scope.split(' ') : []
}

export function requireCancellationGrant(token: string) {
  if (!tokenScopes(decodeJwt(token)).includes(CANCEL_SCOPE)) {
    throw new Error('To cancel tasks, sign out on your phone and sign in again to grant permission.')
  }
}

export function parseSession(body: Record<string, unknown>, clientId: string): DeviceSession {
  if (typeof body.access_token !== 'string' || String(body.token_type).toLowerCase() !== 'bearer') {
    throw new Error('Invalid access token')
  }
  // The issuer supplied this token over HTTPS. The API verifies it independently.
  const claims = decodeJwt(body.access_token)
  const { sub, org_id, exp, client_id, aud } = claims
  if (client_id !== clientId || !sub?.startsWith('user_') ||
      typeof org_id !== 'string' || !org_id.startsWith('org_') ||
      typeof exp !== 'number' || exp * 1000 <= Date.now()) {
    throw new Error('Authorize again and select a workspace')
  }
  // Clerk can issue device grants without aud. An explicit audience must cover the API receiving the token.
  if (aud !== undefined) {
    const audiences = Array.isArray(aud) ? aud : [aud]
    if (!audiences.every(value => typeof value === 'string') || !audiences.includes(MCP_URL)) {
      throw new McpConsentRequired('Clerk issued a device token for a different resource than Okou MCP.')
    }
  }
  const scopes = tokenScopes(claims)
  const missing = CHAT_SCOPES.filter(permission => !scopes.includes(permission))
  if (missing.length) {
    throw new McpConsentRequired('Clerk issued a device token without ' + missing.join(', ') + '.')
  }
  return { accessToken: body.access_token, userId: sub, orgId: org_id, expiresAt: exp * 1000 }
}

export async function deviceCodeHash(code: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
