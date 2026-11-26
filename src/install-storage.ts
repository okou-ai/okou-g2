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

// Two overlapping opens selecting the same missing binding must submit the same
// UUID, including when they belong to different loopback origins.
export async function newThreadId(seed: string, account: string, replaced?: string): Promise<string> {
  const input = encoder.encode(JSON.stringify(['ai.okou.g2/thread/v1', seed, account, replaced ?? null]))
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input)).subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 0x80 // RFC 9562, application-defined UUIDv8
  bytes[8] = (bytes[8] & 63) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function legacyHandle(): string | undefined {
  try {
    const cookie = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(cookieName + '='))
    const handle = cookie?.slice(cookieName.length + 1)
    return handle && validShare.test(handle) ? handle : undefined
  } catch {
    return undefined
  }
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

export const grantKey = 'okou.g2.grant.v2.' + DEVICE_CLIENT_ID

export function parseGrant(raw: string): Grant | undefined {
  if (!raw || raw === 'null') return
  const grant = JSON.parse(raw) as Grant
  if (typeof grant?.refreshToken !== 'string' || !grant.refreshToken || typeof grant.deviceHash !== 'string' || !grant.deviceHash) {
    throw new Error('Unreadable G2 sign-in')
  }
  return grant
}

// Up to 0.4.17, unlocking the existing package record required a cookie share.
// Read it only during upgrade. Fresh installations use the native store alone.
export async function migrateGrant(storage: InstallStorage): Promise<string> {
  const seed = await storage.getLocalStorage(installKey)
  if (!validShare.test(seed)) return ''
  const handle = legacyHandle()
  if (!handle) return ''
  const slot = await grantSlot(handle)
  const value = await storage.getLocalStorage(slot)
  if (!value) return ''
  let grant: Grant | undefined
  try {
    const [iv, ciphertext] = value.split('.')
    const key = await wrappingKey(seed, handle)
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, key, decode(ciphertext))
    grant = parseGrant(new TextDecoder().decode(bytes))
  } catch { return '' }
  if (!grant) return ''
  const current = await storage.getLocalStorage(grantKey)
  if (current) return current
  const raw = JSON.stringify(grant)
  await put(storage, grantKey, raw)
  await put(storage, slot, '')
  await put(storage, installKey, '')
  document.cookie = cookieName + '=; Path=/; SameSite=Strict; Max-Age=0'
  return raw
}
