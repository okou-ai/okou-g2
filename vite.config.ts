import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ablySource = fileURLToPath(new URL('./node_modules/ably/src/', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Ably probes browser storage on import and saves its preferred transport.
    // Use its browser source with the optional storage adapter disabled on G2.
    alias: [
      { find: /^ably$/, replacement: ablySource + 'platform/web/index.ts' },
      { find: /^common\//, replacement: ablySource + 'common/' },
      { find: './lib/util/webstorage', replacement: fileURLToPath(new URL('./src/sync/ably-storage.ts', import.meta.url)) },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
