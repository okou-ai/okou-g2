import { createStore, del, get, set } from 'idb-keyval'
import { DEVICE_CLIENT_ID, DEVICE_SCOPE, OAUTH_ISSUER } from './config'
import { DEVICE_GRANT, deviceCodeHash, parseDeviceCode, parseSession } from './device-protocol'
import type { DeviceCode, DeviceSession } from './types'

export class AuthError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

interface Grant {
  refreshToken: string
  deviceHash: string
}
interface SealedGrant {
  key: CryptoKey
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
}
const credentials = createStore('okou-g2-auth', 'grants')

async function clerk(path: string, params: Record<string, string>) {
  const response = await fetch(OAUTH_ISSUER + path, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    // The iOS WebView bridge can turn URLSearchParams into a string before fetch sets its media type.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: DEVICE_CLIENT_ID, ...params }).toString(),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new AuthError(body?.error ?? 'token_request_failed', response.status)
  }
  return response
}

export class InstalledGrant {
  private memoryOnly?: Grant

  async device() {
    const response = await clerk('/oauth/device_authorization', { scope: DEVICE_SCOPE })
    try {
      return parseDeviceCode(await response.json() as DeviceCode)
    } catch {
      throw new AuthError('invalid_device_response', response.status)
    }
  }

  private async read(): Promise<Grant | undefined> {
    if (this.memoryOnly) return this.memoryOnly
    const sealed = await get<SealedGrant>(DEVICE_CLIENT_ID, credentials).catch(() => undefined)
    if (!sealed) return
    try {
      const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, sealed.key, sealed.ciphertext)
      const grant = JSON.parse(new TextDecoder().decode(bytes)) as Grant
      if (typeof grant.refreshToken === 'string' && typeof grant.deviceHash === 'string') return grant
    } catch {
      // A WebView update may invalidate a stored CryptoKey.
    }
    await this.forget().catch(() => undefined)
  }

  private async save(grant: Grant) {
    // Keep a redeemed grant usable if the WebView cannot persist CryptoKeys.
    this.memoryOnly = grant
    try {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const bytes = new TextEncoder().encode(JSON.stringify(grant))
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)
      await set(DEVICE_CLIENT_ID, { key, iv, ciphertext } satisfies SealedGrant, credentials)
      this.memoryOnly = undefined
    } catch {
      // A fresh sign-in is required after closing a memory-only session.
      await del(DEVICE_CLIENT_ID, credentials).catch(() => undefined)
    }
  }

  private async forget() {
    this.memoryOnly = undefined
    await del(DEVICE_CLIENT_ID, credentials)
  }

  private async exchange(params: Record<string, string>, hash: string, previous?: Grant): Promise<DeviceSession> {
    let response: Response
    try {
      response = await clerk('/oauth/token', params)
    } catch (error) {
      if (previous && error instanceof AuthError && ['invalid_grant', 'access_denied', 'expired_token'].includes(error.code)) {
        await this.forget().catch(() => undefined)
        throw new AuthError('signed_out', 401)
      }
      throw error
    }
    const body = await response.json() as Record<string, unknown>
    let session: DeviceSession
    try { session = parseSession(body, DEVICE_CLIENT_ID) }
    catch { throw new AuthError('workspace_grant_required', 401) }
    const token = body.refresh_token ?? previous?.refreshToken
    if (typeof token !== 'string' || !token) throw new AuthError('offline_grant_required', 401)
    await this.save({ refreshToken: token, deviceHash: hash })
    return session
  }

  async token(deviceCode: string) {
    const hash = await deviceCodeHash(deviceCode)
    const saved = await this.read()
    if (saved?.deviceHash === hash) return this.renew(saved)
    return this.exchange({ grant_type: DEVICE_GRANT, device_code: deviceCode }, hash)
  }

  private renew(grant: Grant) {
    return this.exchange({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }, grant.deviceHash, grant)
  }

  async refresh() {
    const saved = await this.read()
    if (!saved) throw new AuthError('signed_out', 401)
    return this.renew(saved)
  }

  async logout() {
    const saved = await this.read()
    try {
      await this.forget()
    } finally {
      if (saved) await clerk('/oauth/token/revoke', { token: saved.refreshToken, token_type_hint: 'refresh_token' })
    }
  }
}
