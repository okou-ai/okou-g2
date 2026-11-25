import { decodeJwt } from 'jose'
import type { DeviceCode, DeviceSession } from './types'

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export function parseDeviceCode(data: DeviceCode): DeviceCode {
  const url = new URL(data.verification_uri)
  const interval = data.interval ?? 5
  if (typeof data.device_code !== 'string' || !data.device_code ||
      typeof data.user_code !== 'string' || !data.user_code || url.protocol !== 'https:' ||
      url.username || url.password || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 ||
      !Number.isSafeInteger(interval) || interval <= 0) throw new Error('Invalid device code')
  return { device_code: data.device_code, user_code: data.user_code, verification_uri: url.href,
    expires_in: data.expires_in, interval }
}

export function parseSession(body: Record<string, unknown>, clientId: string): DeviceSession {
  if (typeof body.access_token !== 'string' || String(body.token_type).toLowerCase() !== 'bearer') {
    throw new Error('Invalid access token')
  }
  // The issuer supplied this token over HTTPS. The API verifies it independently.
  const { sub, org_id, exp, client_id } = decodeJwt(body.access_token)
  if (client_id !== clientId || !sub?.startsWith('user_') ||
      typeof org_id !== 'string' || !org_id.startsWith('org_') ||
      typeof exp !== 'number' || exp * 1000 <= Date.now()) {
    throw new Error('Authorize again and select a workspace')
  }
  return { accessToken: body.access_token, userId: sub, orgId: org_id, expiresAt: exp * 1000 }
}

export async function deviceCodeHash(code: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
