import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', background: '#1a1a2e', color: '#e94560', minHeight: '100vh' }}>
          <h2 style={{ color: '#fff' }}>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 13 }}>
            {String(this.state.error)}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.href = '/' }}
            style={{ marginTop: 16, padding: '10px 20px', background: '#e94560', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            Reload App
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
