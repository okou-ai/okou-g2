import { connectBridge } from './glasses'
import { exclusive, grantKey, newThreadId, parseGrant, put, type InstallStorage } from './install-storage'
import { API_BASE_URL } from './config'
import { isUuid, type Identity } from './types'
import type { OkouApiClient } from './api/client'

type Binding = { id: string; ready: boolean }
const previewBindings = new Map<string, Binding>()

export class DeviceStore {
  private readonly account: string
  constructor(identity: Identity, private readonly storage: () => Promise<InstallStorage | null> = connectBridge) {
    this.account = JSON.stringify([API_BASE_URL, identity.userId, identity.orgId])
  }

  async fixedThread(client: OkouApiClient, missingThread?: string): Promise<string> {
    const storage = await this.storage()
    const key = 'okou.g2.thread.v1.' + this.account
    const save = async (binding: Binding) => {
      if (storage) await put(storage, key, JSON.stringify(binding))
      else previewBindings.set(key, binding)
    }
    return exclusive(key, async () => {
      const read = async (): Promise<Binding | undefined> => {
        if (!storage) return previewBindings.get(key)
        const raw = await storage.getLocalStorage(key)
        return raw ? JSON.parse(raw) : undefined
      }
      let binding = await read()
      if (binding && (!isUuid(binding.id) || typeof binding.ready !== 'boolean')) throw new Error('Invalid saved G2 conversation')
      if (!binding || (binding.ready && binding.id === missingThread)) {
        const grant = storage && parseGrant(await storage.getLocalStorage(grantKey))
        const id = grant ? await newThreadId(grant.deviceHash, this.account, missingThread) : crypto.randomUUID()
        binding = { id, ready: false }
        await save(binding)
      }
      if (!binding.ready) {
        const thread = await client.call<{ threadId: string }>('create_chat_thread', { clientThreadId: binding.id, title: 'Even G2' })
        if (thread.threadId !== binding.id) throw new Error('Thread creation returned a different ID')
        const current = await read()
        if (current?.id !== binding.id) throw new Error('The device conversation changed')
        if (!current.ready) await save({ ...binding, ready: true })
      }
      return binding.id
    })
  }
}
