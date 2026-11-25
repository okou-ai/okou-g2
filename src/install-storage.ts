import { base64url } from 'jose'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { DEVICE_CLIENT_ID } from './config'

function decode(value: string) { return new Uint8Array(base64url.decode(value)) }

export type InstallStorage = Pick<EvenAppBridge, 'getLocalStorage' | 'setLocalStorage'>
const installKey = 'okou.g2.install.v1'
const cookieName = 'okou_g2_session_' + DEVICE_CLIENT_ID
const validShare = /^[\w-]{43}$/u
const encoder = new TextEncoder()
const purpose = encoder.encode('ai.okou.g2/refresh/v1/' + DEVICE_CLIENT_ID)

export async function put(storage: InstallStorage, key: string, value: string) {
  if (!await storage.setLocalStorage(key, value)) throw new Error('Even App could not save install data')
}

const queues = new Map<string, Promise<unknown>>()
export async function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request(name, work)
  const pending = (queues.get(name) ?? Promise.resolve()).catch(() => undefined).then(work)
  queues.set(name, pending)
  try { return await pending } finally { if (queues.get(name) === pending) queues.delete(name) }
}

export function installation(storage: InstallStorage, create: true): Promise<string>
export function installation(storage: InstallStorage, create: false): Promise<string | undefined>
export async function installation(storage: InstallStorage, create: boolean): Promise<string | undefined> {
  const stored = await storage.getLocalStorage(installKey)
  if (validShare.test(stored)) return stored
  if (!create) {
    if (stored) throw new Error('Unreadable Even App installation')
    return
  }
  return exclusive(installKey, async () => {
    const existing = await storage.getLocalStorage(installKey)
    if (validShare.test(existing)) return existing
    const seed = base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
    await put(storage, installKey, seed)
    return seed
  })
}

// Two overlapping opens selecting the same missing binding must submit the same
// UUID, including when they belong to different loopback origins.
export async function newThreadId(storage: InstallStorage, account: string, replaced?: string): Promise<string> {
  const seed = await installation(storage, true)
  const input = encoder.encode(JSON.stringify(['ai.okou.g2/thread/v1', seed, account, replaced ?? null]))
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input)).subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 0x80 // RFC 9562, application-defined UUIDv8
  bytes[8] = (bytes[8] & 63) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function sessionHandle(): string | undefined {
  try {
    const cookie = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(cookieName + '='))
    const handle = cookie?.slice(cookieName.length + 1)
    return handle && validShare.test(handle) ? handle : undefined
  } catch {
    return undefined
  }
}

function setHandle(handle?: string) {
  // First-party host cookies span the ephemeral Even Hub ports. This random
  // share cannot authorize API requests or decrypt the package record by itself.
  document.cookie = cookieName + '=' + (handle ?? '') + '; Path=/; SameSite=Strict; Max-Age=' +
    (handle ? 365 * 24 * 3600 : 0) + (location.protocol === 'https:' ? '; Secure' : '')
  if (sessionHandle() !== handle) throw new Error('Even App could not persist the install session')
}

async function grantSlot(handle: string) {
  // Store only the hash of the cookie share with the ciphertext.
  const hash = await crypto.subtle.digest('SHA-256', decode(handle))
  return 'okou.g2.grant.v1.' + base64url.encode(new Uint8Array(hash))
}

async function wrappingKey(seed: string, handle: string) {
  const material = await crypto.subtle.importKey('raw', decode(seed), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: decode(handle), info: purpose },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export interface Grant { refreshToken: string; deviceHash: string }

export async function readGrant(storage: InstallStorage, seed: string, handle: string): Promise<Grant | undefined> {
  const value = await storage.getLocalStorage(await grantSlot(handle))
  if (!value) return
  try {
    const [iv, ciphertext] = value.split('.')
    const key = await wrappingKey(seed, handle)
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, key, decode(ciphertext))
    const data = JSON.parse(new TextDecoder().decode(bytes)) as Grant
    if (typeof data.refreshToken === 'string' && data.refreshToken && typeof data.deviceHash === 'string') return data
  } catch {
    // An unreadable record still permits a fresh interactive device sign-in.
  }
}

export async function writeGrant(storage: InstallStorage, grant: Grant, expected: string | undefined, refresh: boolean) {
  const seed = await installation(storage, true)
  const handle = refresh && expected ? expected : base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
  const key = await wrappingKey(seed, handle)
  const slot = await grantSlot(handle)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(grant)))
  if (sessionHandle() !== expected) throw new Error('Install session changed')
  await put(storage, slot, base64url.encode(iv) + '.' + base64url.encode(new Uint8Array(ciphertext)))
  try {
    if (sessionHandle() !== expected) throw new Error('Install session changed')
    setHandle(handle)
  } catch (error) {
    if (sessionHandle() !== handle) await put(storage, slot, '').catch(() => undefined)
    throw error
  }
  if (expected && handle !== expected) await put(storage, await grantSlot(expected), '').catch(() => undefined)
}

export async function clearGrant(storage: InstallStorage, handle: string | undefined) {
  if (sessionHandle() !== handle) return
  try {
    if (handle) setHandle()
  } finally {
    if (handle) await put(storage, await grantSlot(handle), '')
    // Once the package has a marker, an old origin cannot revive a legacy grant on sign-out.
    await installation(storage, true)
  }
}
