import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true, // tunnels (cloudflared / ngrok) use random hostnames
    proxy: { '/api': 'http://localhost:8000', '/health': 'http://localhost:8000' },
  },
})
