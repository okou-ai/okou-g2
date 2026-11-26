import type { InstallStorage } from '../install-storage'

export function host() {
  const records = new Map<string, string>()
  const storage: InstallStorage = {
    getLocalStorage: async (key) => records.get(key) ?? '',
    setLocalStorage: async (key, value) => { records.set(key, value); return true },
  }
  return { records, storage, open: async () => storage }
}
