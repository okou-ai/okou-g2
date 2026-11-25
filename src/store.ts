import { createStore, get, update } from 'idb-keyval'
import { connectBridge } from './glasses'
import { exclusive, newThreadId, put, type InstallStorage } from './install-storage'
import { API_BASE_URL } from './config'
import { isUuid, type Identity } from './types'
import { ApiError, type OkouApiClient } from './api/client'

export interface ThreadMetadata {
  id: string
  computerUseHostId: string | null
  cloudBrowserEnabled: boolean
}

type Binding = { id: string; ready: boolean }
export interface Pending {
  clientEventId: string
  chatThreadSortEventId: string
  fileId: string
  computerUseHostId: string | null
  cloudBrowserEnabled: boolean
}
const database = createStore('okou-g2-device', 'chat')

export async function metadata(client: OkouApiClient, id: string): Promise<ThreadMetadata> {
  const data = await client.request<ThreadMetadata>('/api/chat-threads/' + id + '/metadata')
  if (data.id !== id || typeof data.cloudBrowserEnabled !== 'boolean' ||
      (data.computerUseHostId !== null && !isUuid(data.computerUseHostId))) {
    throw new Error('Invalid thread metadata')
  }
  return data
}

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

  async fixedThread(client: OkouApiClient): Promise<string> {
    const storage = await this.storage()
    let binding = await this.reserve(storage)
    if (binding.ready) {
      try {
        await metadata(client, binding.id)
        return binding.id
      } catch (error) {
        if (!(error instanceof ApiError && (error.status === 404 || error.status === 410))) throw error
      }
      binding = await this.reserve(storage, binding.id)
      if (binding.ready) return binding.id
    }
    const thread = await client.request<{ id: string }>('/api/chat-threads', { clientThreadId: binding.id, title: 'Even G2' })
    if (thread.id !== binding.id) throw new Error('Thread creation returned a different ID')
    await this.updateBinding(storage, (current) => {
      if (current?.id !== binding.id) throw new Error('The device conversation changed')
      return { ...current, ready: true }
    })
    return binding.id
  }

  private pendingKey(id: string) { return [this.key, id, 'pending'] }

  pending(id: string) { return get<Pending>(this.pendingKey(id), database) }

  async reserveSend(target: ThreadMetadata, fileId: string): Promise<Pending> {
    const pending = {
      clientEventId: crypto.randomUUID(), chatThreadSortEventId: crypto.randomUUID(), fileId,
      computerUseHostId: target.computerUseHostId, cloudBrowserEnabled: target.cloudBrowserEnabled,
    }
    await update<Pending>(this.pendingKey(target.id), (current) => {
      if (current) throw new Error('The previous send is awaiting confirmation')
      return pending
    }, database)
    return pending
  }

  async acknowledge(id: string, eventId: string) {
    // A delayed response must not clear a newer send's reservation.
    await update<Pending | null>(this.pendingKey(id),
      (current) => current?.clientEventId === eventId ? null : current ?? null, database)
  }
}
