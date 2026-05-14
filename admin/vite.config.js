import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND = process.env.VITE_BACKEND_URL || 'http://localhost:1404'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 1402,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
})