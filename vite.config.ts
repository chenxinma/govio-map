import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { wsPlugin } from './server/index.js'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  plugins: [react(), tailwindcss(), wsPlugin()],
  server: {
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 700,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
