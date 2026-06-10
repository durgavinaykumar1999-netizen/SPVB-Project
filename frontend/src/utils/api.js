// Try to get backend URL from environment, fallback to production backend
const BACKEND = import.meta.env.VITE_BACKEND_URL || 'https://spvb-backend.onrender.com'

// Local mode: bypass server, store all data in IndexedDB (for E2E V2 testing)
// Enable:  localStorage.setItem('spvb_local_mode', '1')
// Disable: localStorage.removeItem('spvb_local_mode')
export const LOCAL_MODE = localStorage.getItem('spvb_local_mode') === '1'

// Debug: Log backend URL once on page load
if (typeof window !== 'undefined' && !window.__spvb_api_logged) {
  window.__spvb_api_logged = true
  console.log('[API] Backend URL:', BACKEND)
}

export const apiUrl = (path) => {
  // Send path as-is - backend expects /api prefix
  const fullUrl = `${BACKEND}${path}`
  console.log(`[API] ${path} → ${fullUrl}`)
  return fullUrl
}

export const wsUrl = (path) => {
  // Always use BACKEND URL for WebSocket - never use localhost
  // Use wss for production, ws for localhost dev
  const backendHost = BACKEND.replace(/^https?:\/\//, '')
  const isLocalhost = backendHost.includes('localhost') || backendHost.includes('127.0.0.1')
  const proto = isLocalhost ? 'ws' : 'wss'
  return `${proto}://${backendHost}${path}`
}
