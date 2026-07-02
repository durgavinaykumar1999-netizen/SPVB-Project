import { useState, useRef } from 'react'
import { apiUrl } from '../utils/api.js'

export default function ScheduleMessageModal({ isOpen, onClose, contactName, contactId, onSchedule }) {
  const [messageText, setMessageText] = useState('')
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [fileName, setFileName] = useState('')
  const [previewMode, setPreviewMode] = useState(false)
  const fileInputRef = useRef(null)

  const today = new Date().toISOString().split('T')[0]
  const currentTime = new Date().toTimeString().slice(0, 5)

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      setFileName(file.name)
    }
  }

  const removeFile = () => {
    setSelectedFile(null)
    setFileName('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSchedule = async () => {
    if (!messageText.trim() && !selectedFile) {
      alert('Please enter a message or select a file')
      return
    }
    if (!scheduleDate || !scheduleTime) {
      alert('Please select date and time')
      return
    }

    const scheduledDateTime = new Date(`${scheduleDate}T${scheduleTime}`)
    const now = new Date()

    if (scheduledDateTime <= now) {
      alert('Please select a future date and time')
      return
    }

    const formData = new FormData()
    formData.append('contact_id', contactId)
    formData.append('message', messageText)
    formData.append('scheduled_time', scheduledDateTime.toISOString())
    if (selectedFile) {
      formData.append('file', selectedFile)
    }

    try {
      const token = localStorage.getItem('token')
      const response = await fetch(apiUrl('/api/messages/schedule'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })

      if (!response.ok) throw new Error('Failed to schedule message')

      onSchedule?.({
        message: messageText,
        fileName,
        scheduledTime: scheduledDateTime,
      })

      // Reset form
      setMessageText('')
      setScheduleDate('')
      setScheduleTime('')
      setSelectedFile(null)
      setFileName('')
      onClose()
    } catch (error) {
      alert('Error scheduling message: ' + error.message)
    }
  }

  if (!isOpen) return null

  const formatPreviewTime = () => {
    if (!scheduleDate || !scheduleTime) return 'Select date & time'
    const d = new Date(`${scheduleDate}T${scheduleTime}`)
    return d.toLocaleString()
  }

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
          maxHeight: '90vh',
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
            📅 Schedule Message
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
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          {/* Contact Info */}
          <div
            style={{
              background: '#f5f5f5',
              padding: 12,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: '#00a884',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 700,
              }}
            >
              {(contactName?.[0] || '?').toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600, color: '#000' }}>{contactName}</div>
              <div style={{ fontSize: 12, color: '#666' }}>Message will be sent automatically</div>
            </div>
          </div>

          {/* Message Input */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 600, fontSize: 13, color: '#000' }}>
              ✍️ Message
            </label>
            <textarea
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Type your message here..."
              style={{
                width: '100%',
                minHeight: 100,
                padding: 12,
                border: '1px solid #e5e5ea',
                borderRadius: 12,
                fontFamily: 'inherit',
                fontSize: 14,
                resize: 'none',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
              {messageText.length} characters
            </div>
          </div>

          {/* File Upload */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 600, fontSize: 13, color: '#000' }}>
              📎 Attachment (Optional)
            </label>
            {!selectedFile ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: '2px dashed #00a884',
                  borderRadius: 12,
                  padding: 20,
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: '#f0fdf9',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#e8fef5'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#f0fdf9'
                }}
              >
                <div style={{ fontSize: 24, marginBottom: 8 }}>📁</div>
                <div style={{ fontWeight: 600, color: '#00a884', marginBottom: 4 }}>Tap to add file</div>
                <div style={{ fontSize: 12, color: '#666' }}>Images, documents, videos...</div>
              </div>
            ) : (
              <div
                style={{
                  background: '#f5f5f5',
                  padding: 12,
                  borderRadius: 12,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>📄</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#000' }}>{fileName}</div>
                    <div style={{ fontSize: 11, color: '#999' }}>File selected</div>
                  </div>
                </div>
                <button
                  onClick={removeFile}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 18,
                    cursor: 'pointer',
                    color: '#ff4757',
                  }}
                >
                  ✕
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
          </div>

          {/* Schedule Time */}
          <div>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 600, fontSize: 13, color: '#000' }}>
              ⏰ Schedule Date & Time
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <input
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  min={today}
                  style={{
                    width: '100%',
                    padding: 10,
                    border: '1px solid #e5e5ea',
                    borderRadius: 8,
                    fontFamily: 'inherit',
                    fontSize: 14,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <div>
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  style={{
                    width: '100%',
                    padding: 10,
                    border: '1px solid #e5e5ea',
                    borderRadius: 8,
                    fontFamily: 'inherit',
                    fontSize: 14,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>
            <div style={{ marginTop: 8, padding: 8, background: '#f5f5f5', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: '#666' }}>📆 Scheduled for:</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#00a884' }}>{formatPreviewTime()}</div>
            </div>
          </div>

          {/* Preview Toggle */}
          <button
            onClick={() => setPreviewMode(!previewMode)}
            style={{
              background: 'none',
              border: 'none',
              color: '#00a884',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {previewMode ? '▼' : '▶'} Preview Message
          </button>

          {/* Preview */}
          {previewMode && (
            <div
              style={{
                background: '#f5f5f5',
                padding: 12,
                borderRadius: 12,
                border: '1px solid #e5e5ea',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 8 }}>Preview</div>
              <div style={{ background: '#fff', padding: 12, borderRadius: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: '#000', wordBreak: 'break-word' }}>
                  {messageText || '(No message)'}
                </div>
                {fileName && (
                  <div style={{ marginTop: 8, padding: 8, background: '#f0f0f0', borderRadius: 6 }}>
                    📄 {fileName}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#999' }}>
                Will be sent on {formatPreviewTime()}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid #e5e5ea',
            display: 'flex',
            gap: 10,
          }}
        >
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: '10px 16px',
              border: '1px solid #e5e5ea',
              borderRadius: 8,
              background: '#fff',
              color: '#000',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f5f5f5'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#fff'
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSchedule}
            style={{
              flex: 1,
              padding: '10px 16px',
              border: 'none',
              borderRadius: 8,
              background: '#00a884',
              color: '#fff',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#00a884aa'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#00a884'
            }}
          >
            ✓ Schedule Message
          </button>
        </div>
      </div>
    </>
  )
}
