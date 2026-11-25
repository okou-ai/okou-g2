import { createStore, del, get, set } from 'idb-keyval'
import { DEVICE_CLIENT_ID, DEVICE_SCOPE, OAUTH_ISSUER } from './config'
import { DEVICE_GRANT, deviceCodeHash, parseDeviceCode, parseSession } from './device-protocol'
import type { DeviceCode, DeviceSession } from './types'
import { connectBridge } from './glasses'
import { clearGrant, installation, readGrant, sessionHandle, writeGrant, type Grant, type InstallStorage } from './install-storage'

export class AuthError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

interface SavedGrant extends Grant { handle?: string }
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
  private memoryOnly?: SavedGrant

  constructor(private readonly storage: () => Promise<InstallStorage | null> = connectBridge) {}

  async hasInstalledSession() {
    return !!await this.storage() && !!sessionHandle()
  }

  async device() {
    const response = await clerk('/oauth/device_authorization', { scope: DEVICE_SCOPE })
    try {
      return parseDeviceCode(await response.json() as DeviceCode)
    } catch {
      throw new AuthError('invalid_device_response', response.status)
    }
  }

  private async read(): Promise<SavedGrant | undefined> {
    const storage = await this.storage()
    if (this.memoryOnly && (!storage || this.memoryOnly.handle === sessionHandle())) return this.memoryOnly
    this.memoryOnly = undefined
    if (storage) {
      const seed = await installation(storage, false)
      const handle = sessionHandle()
      if (seed || handle) {
        if (!seed || !handle) return
        const grant = await readGrant(storage, seed, handle)
        return grant && { ...grant, handle }
      }
    }
    // Import a 0.4.3 grant only before this package has its own installation.
    const sealed = await get<SealedGrant>(DEVICE_CLIENT_ID, credentials).catch(() => undefined)
    if (!sealed) return
    try {
      const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, sealed.key, sealed.ciphertext)
      const grant = JSON.parse(new TextDecoder().decode(bytes)) as Grant
      if (typeof grant.refreshToken === 'string' && typeof grant.deviceHash === 'string') return grant
    } catch {
      // A WebView update may invalidate a stored CryptoKey.
    }
    await del(DEVICE_CLIENT_ID, credentials).catch(() => undefined)
  }

  private async save(grant: Grant, storage: InstallStorage | null, expectedHandle?: string, previous?: SavedGrant): Promise<boolean> {
    try {
      if (storage) {
        if (sessionHandle() !== expectedHandle) throw new AuthError('signed_out', 401)
        if (previous?.handle && !this.memoryOnly) {
          // A delayed successful response must not overwrite a grant another port has already rotated.
          const latest = await this.read()
          if (latest?.handle === previous.handle && latest.refreshToken !== previous.refreshToken) return true
        }
        await writeGrant(storage, grant, expectedHandle, !!previous?.handle)
        this.memoryOnly = undefined
        // Native credentials are now authoritative, even if the legacy database is later restored.
        if (!previous?.handle) await del(DEVICE_CLIENT_ID, credentials).catch(() => undefined)
        return true
      }
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const bytes = new TextEncoder().encode(JSON.stringify(grant))
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)
      await set(DEVICE_CLIENT_ID, { key, iv, ciphertext } satisfies SealedGrant, credentials)
      this.memoryOnly = undefined
      return true
    } catch {
      if (storage && sessionHandle() !== expectedHandle) {
        this.memoryOnly = undefined
        throw new AuthError('signed_out', 401)
      }
      // The issuer has already consumed the device code or rotated this refresh token.
      this.memoryOnly = { ...grant, handle: expectedHandle }
      return false
    }
  }

  private async forget(storage: InstallStorage | null, handle?: string) {
    this.memoryOnly = undefined
    if (storage) {
      try { await clearGrant(storage, handle) }
      finally { await del(DEVICE_CLIENT_ID, credentials).catch(() => undefined) }
    } else {
      await del(DEVICE_CLIENT_ID, credentials)
    }
  }

  private async exchange(params: Record<string, string>, hash: string, previous?: SavedGrant, retry = true): Promise<DeviceSession> {
    const storage = await this.storage()
    const expectedHandle = storage ? sessionHandle() : undefined
    if (previous?.handle && previous.handle !== expectedHandle) throw new AuthError('signed_out', 401)
    let response: Response
    try {
      response = await clerk('/oauth/token', params)
    } catch (error) {
      if (previous && error instanceof AuthError && ['invalid_grant', 'access_denied', 'expired_token'].includes(error.code)) {
        // An older WebView may lose a rotation race. Never erase a newer grant on a stale rejection.
        const latest = await this.read()
        if (retry && latest?.deviceHash === hash && latest.refreshToken !== previous.refreshToken) return this.renew(latest, false)
        this.memoryOnly = undefined
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
    const persisted = await this.save({ refreshToken: token, deviceHash: hash }, storage, expectedHandle, previous)
    return persisted ? session : { ...session, temporary: true }
  }

  async token(deviceCode: string) {
    const hash = await deviceCodeHash(deviceCode)
    // An explicit sign-in can replace an unreadable installation.
    const saved = await this.read().catch(() => undefined)
    if (saved?.deviceHash === hash) return this.renew(saved)
    return this.exchange({ grant_type: DEVICE_GRANT, device_code: deviceCode }, hash)
  }

  private renew(grant: SavedGrant, retry = true): Promise<DeviceSession> {
    return this.exchange({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }, grant.deviceHash, grant, retry)
  }

  async refresh() {
    const saved = await this.read()
    if (!saved) throw new AuthError('signed_out', 401)
    return this.renew(saved)
  }

  async logout() {
    const storage = await this.storage()
    const handle = storage ? sessionHandle() : undefined
    let saved: SavedGrant | undefined
    try {
      try { saved = await this.read() }
      finally { await this.forget(storage, handle) }
    } finally {
      if (saved && (!storage || saved.handle === handle)) {
        await clerk('/oauth/token/revoke', { token: saved.refreshToken, token_type_hint: 'refresh_token' })
      }
    }
  }
}
