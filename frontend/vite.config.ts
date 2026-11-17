import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // older phones' Telegram (Android WebView, iOS Safari) choke on the newest syntax: lower it (??=, ?. …)
  build: { target: ['es2019', 'chrome79', 'safari13'] },
  server: {
    host: true,
    allowedHosts: true, // tunnels (cloudflared / ngrok) use random hostnames
    proxy: { '/api': 'http://localhost:8000', '/health': 'http://localhost:8000' },
  },
})
