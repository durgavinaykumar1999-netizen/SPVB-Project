const BACKEND = import.meta.env.VITE_BACKEND_URL || ''

// Local mode: bypass server, store all data in IndexedDB (for E2E V2 testing)
// Enable:  localStorage.setItem('spvb_local_mode', '1')
// Disable: localStorage.removeItem('spvb_local_mode')
export const LOCAL_MODE = localStorage.getItem('spvb_local_mode') === '1'

export const apiUrl = (path) => {
  if (!BACKEND) return path

  // If path starts with /api, use it as-is with BACKEND base
  // BACKEND is already https://example.com (without /api)
  // So /api/users/me → https://example.com/api/users/me
  return `${BACKEND}${path}`
}

export const wsUrl = (path) => {
  if (import.meta.env.VITE_BACKEND_URL) {
    const ws = import.meta.env.VITE_BACKEND_URL.replace(/^http/, 'ws')
    return `${ws}${path.replace(/^\/ws/, '/ws')}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${path}`
}
