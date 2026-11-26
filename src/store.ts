import { createStore, get, update } from 'idb-keyval'
import { connectBridge } from './glasses'
import { exclusive, newThreadId, put, type InstallStorage } from './install-storage'
import { API_BASE_URL } from './config'
import { isUuid, type Identity } from './types'
import type { OkouApiClient } from './api/client'

type Binding = { id: string; ready: boolean }
export interface Pending {
  clientEventId: string
  fileIds: string[]
  additionalInfo?: string
}
type StoredPending = Pending | { clientEventId: string; fileId: string }
const database = createStore('okou-g2-device', 'chat')

export class DeviceStore {
  private readonly key: string
  constructor(identity: Identity, private readonly storage: () => Promise<InstallStorage | null> = connectBridge) {
    this.key = JSON.stringify([API_BASE_URL, identity.userId, identity.orgId])
  }

  private async updateBinding(storage: InstallStorage | null, change: (current?: Binding) => Binding): Promise<Binding> {
    if (!storage) {
      let selected!: Binding
      await update<Binding>(this.key, (old) => (selected = change(old)), database)
      return selected
    }
    const key = 'okou.g2.thread.v1.' + this.key
    return exclusive(key, async () => {
      const raw = await storage.getLocalStorage(key)
      const current: Binding | undefined = raw ? JSON.parse(raw) : await get<Binding>(this.key, database).catch(() => undefined)
      if (current && (!isUuid(current.id) || typeof current.ready !== 'boolean')) throw new Error('Invalid saved G2 conversation')
      const next = change(current)
      if (!raw || next !== current) await put(storage, key, JSON.stringify(next))
      return next
    })
  }

  private async reserve(storage: InstallStorage | null, replace?: string): Promise<Binding> {
    const candidate = storage ? await newThreadId(storage, this.key, replace) : crypto.randomUUID()
    return this.updateBinding(storage, (old) => !old || (old.ready && old.id === replace)
      ? { id: candidate, ready: false } : old)
  }

  async fixedThread(client: OkouApiClient, missingThread?: string): Promise<string> {
    const storage = await this.storage()
    const binding = await this.reserve(storage, missingThread)
    if (binding.ready) return binding.id
    const thread = await client.call<{ threadId: string }>('create_chat_thread', { clientThreadId: binding.id, title: 'Even G2' })
    if (thread.threadId !== binding.id) throw new Error('Thread creation returned a different ID')
    await this.updateBinding(storage, (current) => {
      if (current?.id !== binding.id) throw new Error('The device conversation changed')
      return { ...current, ready: true }
    })
    return binding.id
  }

  private pendingKey(id: string) { return [this.key, id, 'pending'] }

  async pending(id: string): Promise<Pending | undefined> {
    const saved = await get<StoredPending>(this.pendingKey(id), database)
    if (!saved) return
    return 'fileIds' in saved ? saved : { clientEventId: saved.clientEventId, fileIds: [saved.fileId] }
  }

  async reserveSend(thread: string, fileIds: string[], additionalInfo: string): Promise<Pending> {
    const pending = { clientEventId: crypto.randomUUID(), fileIds, additionalInfo }
    await update<StoredPending>(this.pendingKey(thread), (current) => {
      if (current) throw new Error('The previous send is awaiting confirmation')
      return pending
    }, database)
    return pending
  }

  async acknowledge(id: string, eventId: string) {
    // A delayed response must not clear a newer send's reservation.
    await update<StoredPending | null>(this.pendingKey(id),
      (current) => current?.clientEventId === eventId ? null : current ?? null, database)
  }
}
