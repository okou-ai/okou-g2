import { createStore, get, update } from 'idb-keyval'
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
  constructor(identity: Identity) {
    this.key = JSON.stringify([API_BASE_URL, identity.userId, identity.orgId])
  }

  // The reservation commits before the network request. IndexedDB serializes
  // this update even when two WebViews open the account simultaneously.
  private async reserve(replace?: string): Promise<Binding> {
    let selected!: Binding
    await update<Binding>(this.key, (old) => {
      selected = !old || (old.ready && old.id === replace) ? { id: crypto.randomUUID(), ready: false } : old
      return selected
    }, database)
    return selected
  }

  async fixedThread(client: OkouApiClient): Promise<string> {
    let binding = await this.reserve()
    if (binding.ready) {
      try {
        await metadata(client, binding.id)
        return binding.id
      } catch (error) {
        if (!(error instanceof ApiError && (error.status === 404 || error.status === 410))) throw error
      }
      binding = await this.reserve(binding.id)
      if (binding.ready) return binding.id
    }
    const thread = await client.request<{ id: string }>('/api/chat-threads', { clientThreadId: binding.id, title: 'Even G2' })
    if (thread.id !== binding.id) throw new Error('Thread creation returned a different ID')
    await update<Binding>(this.key, (current) => {
      if (current?.id !== binding.id) throw new Error('The device conversation changed')
      return { ...current, ready: true }
    }, database)
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
