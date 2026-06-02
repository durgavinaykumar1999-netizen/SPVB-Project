import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  // Load all env vars (including VITE_FIREBASE_*)
  const env = loadEnv(mode, __dirname, '')

  const firebaseConfigJSON = JSON.stringify({
    apiKey:            env.VITE_FIREBASE_API_KEY             || '',
    authDomain:        env.VITE_FIREBASE_AUTH_DOMAIN         || '',
    projectId:         env.VITE_FIREBASE_PROJECT_ID          || '',
    storageBucket:     env.VITE_FIREBASE_STORAGE_BUCKET      || '',
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
    appId:             env.VITE_FIREBASE_APP_ID              || '',
  })

  // Plugin: inject Firebase config into the service worker at build time + dev time.
  // This makes background push notifications work even when the app is fully closed.
  const injectFirebaseSW = {
    name: 'inject-firebase-sw',

    // Dev server: serve /firebase-messaging-sw.js with config injected
    configureServer(server) {
      server.middlewares.use('/firebase-messaging-sw.js', (_req, res) => {
        try {
          const template = fs.readFileSync(
            path.resolve(__dirname, 'public/firebase-messaging-sw.js'), 'utf8'
          )
          const injected = template.replace('__FIREBASE_CONFIG__', firebaseConfigJSON)
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          res.setHeader('Service-Worker-Allowed', '/')
          res.end(injected)
        } catch (e) {
          res.statusCode = 500
          res.end(`// SW inject error: ${e.message}`)
        }
      })
    },

    // Production build: patch the copied file in dist/ after bundle is written
    closeBundle() {
      const swPath = path.resolve(__dirname, 'dist/firebase-messaging-sw.js')
      if (!fs.existsSync(swPath)) return
      const content = fs.readFileSync(swPath, 'utf8')
      const patched = content.replace('__FIREBASE_CONFIG__', firebaseConfigJSON)
      fs.writeFileSync(swPath, patched)
      console.log('[inject-firebase-sw] config injected into dist/firebase-messaging-sw.js')
    },
  }

  return {
    plugins: [react(), injectFirebaseSW],
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1000,
      target: 'es2020',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router-dom')) {
              return 'react-vendor'
            }
            if (id.includes('node_modules/qrcode')) {
              return 'qrcode'
            }
          },
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 1402,
      proxy: {
        '/api': {
          target: 'http://localhost:1404',
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api/, '')
        },
        '/ws': {
          target: 'ws://localhost:1404',
          changeOrigin: true,
          ws: true,
          secure: false
        },
        '/uploads': {
          target: 'http://localhost:1404',
          changeOrigin: true,
          secure: false
        }
      }
    }
  }
})
