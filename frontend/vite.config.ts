import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // older phones' Telegram (Android WebView, iOS Safari) choke on the newest syntax: lower it (??=, ?. …)
  // manifest: the list of built files, which public/sw.js keeps on the phone so every screen opens offline
  build: { target: ['es2019', 'chrome79', 'safari13'], manifest: true },
  server: {
    host: true,
    allowedHosts: true, // tunnels (cloudflared / ngrok) use random hostnames
    proxy: { '/api': 'http://localhost:8000', '/health': 'http://localhost:8000' },
  },
})
