import { useState, useEffect } from 'react'
import { apiUrl } from '../utils/api.js'

export default function ScheduledMessagesList({ contactId, onEdit, isOpen, onClose }) {
  const [scheduledMessages, setScheduledMessages] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isOpen) {
      fetchScheduledMessages()
    }
  }, [isOpen, contactId])

  const fetchScheduledMessages = async () => {
    setLoading(true)
    try {
      const token = localStorage.getItem('token')
      const response = await fetch(apiUrl(`/api/messages/scheduled?contact_id=${contactId}`), {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!response.ok) throw new Error('Failed to fetch scheduled messages')
      const data = await response.json()
      setScheduledMessages(data.scheduled_messages || [])
    } catch (error) {
      console.error('Error fetching scheduled messages:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (messageId) => {
    if (!window.confirm('Delete this scheduled message?')) return

    try {
      const token = localStorage.getItem('token')
      const response = await fetch(apiUrl(`/api/messages/scheduled/${messageId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!response.ok) throw new Error('Failed to delete message')
      setScheduledMessages(scheduledMessages.filter((m) => m.id !== messageId))
    } catch (error) {
      alert('Error deleting message: ' + error.message)
    }
  }

  const formatTime = (isoString) => {
    const d = new Date(isoString)
    const now = new Date()
    const diff = d - now

    if (diff < 60000) return 'Sending now...'
    if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`
    if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h`

    return d.toLocaleString()
  }

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 2000,
          backdropFilter: 'blur(4px)',
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(90vw, 480px)',
          maxHeight: '80vh',
          background: '#fff',
          borderRadius: 20,
          overflow: 'hidden',
          zIndex: 2001,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #e5e5ea',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#000' }}>
            📅 Scheduled Messages ({scheduledMessages.length})
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 24,
              cursor: 'pointer',
              color: '#666',
            }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {loading ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: '#999' }}>
              Loading scheduled messages...
            </div>
          ) : scheduledMessages.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: '#999' }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>📭</div>
              <div>No scheduled messages</div>
            </div>
          ) : (
            scheduledMessages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  background: '#f5f5f5',
                  borderRadius: 12,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                {/* Message Content */}
                <div
                  style={{
                    background: '#fff',
                    padding: 10,
                    borderRadius: 8,
                    borderLeft: '4px solid #00a884',
                  }}
                >
                  <div style={{ fontSize: 13, color: '#000', wordBreak: 'break-word' }}>
                    {msg.message}
                  </div>
                  {msg.file_name && (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}>
                      📎 {msg.file_name}
                    </div>
                  )}
                </div>

                {/* Time & Actions */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      color: '#00a884',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    ⏰ {formatTime(msg.scheduled_time)}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => onEdit(msg)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#00a884',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        padding: '4px 8px',
                        borderRadius: 6,
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(0,168,132,0.1)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'none'
                      }}
                    >
                      ✎ Edit
                    </button>
                    <button
                      onClick={() => handleDelete(msg.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#ff4757',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        padding: '4px 8px',
                        borderRadius: 6,
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255,71,87,0.1)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'none'
                      }}
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid #e5e5ea',
            textAlign: 'right',
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderRadius: 8,
              background: '#00a884',
              color: '#fff',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      </div>
    </>
  )
}
