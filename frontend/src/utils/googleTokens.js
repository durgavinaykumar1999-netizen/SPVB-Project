const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
].join(' ')

export async function syncContactsWithToken(accessToken) {
  const res = await fetch(
    'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,photos&pageSize=500',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await res.json()
  const contacts = (data.connections || [])
    .map((p) => ({
      name: p.names?.[0]?.displayName || '',
      email: p.emailAddresses?.[0]?.value || '',
      photo: p.photos?.[0]?.url || '',
    }))
    .filter((c) => c.email)
  localStorage.setItem('google_contacts', JSON.stringify(contacts))
  localStorage.setItem('google_contacts_synced_at', String(Date.now()))
  return contacts
}

export function storeGmailToken(accessToken, expiresIn) {
  localStorage.setItem('gmail_access_token', accessToken)
  localStorage.setItem('gmail_token_expiry', String(Date.now() + (expiresIn || 3600) * 1000))
}

export function isGmailTokenValid() {
  const expiry = parseInt(localStorage.getItem('gmail_token_expiry') || '0')
  return Date.now() < expiry - 60000 // 1 min buffer
}

// Request Gmail + Contacts with full consent (used at registration for new users)
export function requestAllGooglePermissions(clientId, onDone) {
  if (!clientId || !window.google?.accounts?.oauth2) { onDone?.(null); return }
  const tc = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: async (r) => {
      if (r.access_token) {
        storeGmailToken(r.access_token, r.expires_in)
        localStorage.setItem('google_auth', 'true')
        try { await syncContactsWithToken(r.access_token) } catch {}
      }
      onDone?.(r.access_token || null)
    },
    error_callback: () => onDone?.(null),
  })
  tc.requestAccessToken({ prompt: 'consent' })
}

// Silently refresh tokens — never shows any UI to the user
export function silentlyRefreshGoogleTokens(clientId) {
  if (!clientId || !window.google?.accounts?.oauth2) return
  if (isGmailTokenValid()) return // already valid, skip
  try {
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: async (r) => {
        if (r.access_token) {
          storeGmailToken(r.access_token, r.expires_in)
          try { await syncContactsWithToken(r.access_token) } catch {}
        }
      },
      error_callback: () => {}, // silently ignore failures
    })
    tc.requestAccessToken({ prompt: 'none' })
  } catch {}
}
