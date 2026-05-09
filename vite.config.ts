import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { wsPlugin } from './server/index.js'

export default defineConfig({
  plugins: [react(), tailwindcss(), wsPlugin()],
  server: {
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 700,
  },
})
