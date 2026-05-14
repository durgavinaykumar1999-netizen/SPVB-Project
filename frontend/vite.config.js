import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND = process.env.VITE_BACKEND_URL || 'http://localhost:1404'
const WS_BACKEND = BACKEND.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 1403,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, '')
      },
      '/ws': {
        target: WS_BACKEND,
        changeOrigin: true,
        ws: true,
        secure: false
      },
      '/uploads': {
        target: BACKEND,
        changeOrigin: true,
        secure: false
      }
    }
  }
})