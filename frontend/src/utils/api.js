const BACKEND = import.meta.env.VITE_BACKEND_URL || ''

export const apiUrl = (path) => {
  const stripped = BACKEND ? path.replace(/^\/api/, '') : path
  return `${BACKEND}${stripped}`
}

export const wsUrl = (path) => {
  if (import.meta.env.VITE_BACKEND_URL) {
    const ws = import.meta.env.VITE_BACKEND_URL.replace(/^http/, 'ws')
    return `${ws}${path.replace(/^\/ws/, '/ws')}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${path}`
}
