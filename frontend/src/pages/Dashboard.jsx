




import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { silentlyRefreshGoogleTokens, syncContactsWithToken, isGmailTokenValid, storeGmailToken, requestAllGooglePermissions } from '../utils/googleTokens'
import { wsUrl, apiUrl } from '../utils/api'
import { getOrCreateKeyPair, encryptMessage, decryptMessage, exportKeyBackup, importKeyBackup, replaceKeyPairFromBackup, deleteStoredKeyPair } from '../utils/e2e'
import { loadMasterKeyPair, deleteMasterKeyPair, encryptMessageForTwo, decryptMessageWithWrappedKey, importRsaPublicKey, isV2Message, setupMasterKeyAfterLogin } from '../utils/e2eV2'
import { LOCAL_MODE, localSaveMessage, localGetConversation, localSavePubKey, localGetPubKey } from '../utils/localStore'
import { authenticateBiometric, hasBiometricRegistered } from '../utils/biometric'
import { RINGTONES, CALL_RINGTONES, playRingtone, getContactRingtone, setContactRingtoneLocal } from '../utils/ringtones'
import CallScreen from '../components/CallScreen'
import IncomingCallBanner from '../components/IncomingCallBanner'
import AddContactModal from '../components/AddContactModal'
import StatusViewer from '../components/StatusViewer'
import ImageCropper from '../components/ImageCropper'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const isGoogleUser = () => localStorage.getItem('google_auth') === 'true'

/* ── Gmail helpers ── */
function parseEmailMeta(msg) {
  const h = msg.payload?.headers || []
  const get = (n) => h.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value || ''
  const rawFrom = get('From')
  const fromName = rawFrom.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || rawFrom.split('@')[0] || rawFrom
  const fromEmail = rawFrom.match(/<(.+)>/)?.[1] || rawFrom
  const rawDate = get('Date')
  const d = rawDate ? new Date(rawDate) : new Date(parseInt(msg.internalDate || 0))
  const now = new Date()
  let dateStr
  if (d.toDateString() === now.toDateString()) dateStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  else if (now - d < 6 * 86400000) dateStr = d.toLocaleDateString([], { weekday: 'short' })
  else dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return { id: msg.id, subject: get('Subject') || '(no subject)', fromName, fromEmail, to: get('To'), date: dateStr, rawDate: d, snippet: msg.snippet || '', isUnread: (msg.labelIds || []).includes('UNREAD') }
}

function extractBody(payload) {
  if (!payload) return ''
  if (payload.body?.data) {
    try { return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/')) } catch { return '' }
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) {
        try { return atob(p.body.data.replace(/-/g, '+').replace(/_/g, '/')) } catch { return '' }
      }
    }
    for (const p of payload.parts) { const n = extractBody(p); if (n) return n }
  }
  return ''
}

const AVATAR_COLORS = ['#25d366','#128c7e','#f39c12','#8e44ad','#2980b9','#e74c3c','#16a085','#d35400','#2c3e50','#6c5ce7']
const BOT_CONTACT = { id: 'bot', name: 'AI Assistant', initials: 'AI', color: '#6c5ce7', about: 'SPVB smart assistant', isGroup: false }
const SELF_CHAT_ID = '__self__'
const EMOJI_CATS = [
  { id: 'smileys', icon: '😀', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥸','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
  { id: 'people', icon: '👋', emojis: ['👋','🤚','🖐️','✋','🖖','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','💪','👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓','👴','👵','👮','🕵️','💂','🥷','👷','🤴','👸','👳','👲','🧕','🤵','👰','🧙','🧚','🧛','🧜','🧝','🧞','🧟','🏃','💃','🕺','🧗','🏋️','🤼','🤸','🏄','🚵','🚴','🧘'] },
  { id: 'hearts', icon: '❤️', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','❤️‍🔥','❤️‍🩹','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','💌','💋','💯','💢','💥','💫','💦','💨','💬','💭','🗯️','✨','⭐','🌟','🔥','🎉','🎊','🎈','🎁','🎀','🏆','🥇','🥈','🥉'] },
  { id: 'animals', icon: '🐶', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🕷️','🦂','🐢','🐍','🦎','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🦭','🐊','🐅','🐆','🦓','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦦','🦥','🐁','🐀','🐿️','🦔','🌵','🌲','🌳','🌴','🌱','🌿','☘️','🍀','🍁','🍂','🍃','🍄','🌺','🌸','🌼','🌻','🌹','🥀','🌷'] },
  { id: 'food', icon: '🍕', emojis: ['🍎','🍊','🍋','🍇','🍓','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🧄','🧅','🥔','🍞','🥐','🥖','🥨','🥯','🧀','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🌮','🌯','🥙','🥗','🍜','🍝','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🍘','🍥','🥮','🍢','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','☕','🍵','🧃','🥤','🧋','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🍾','🥛','🍼'] },
  { id: 'travel', icon: '✈️', emojis: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍️','🛵','🚲','🛴','🛹','⛽','🚨','🚥','🚦','🛑','🚧','⚓','⛵','🚤','🛥️','🛳️','⛴️','🚢','✈️','🛩️','🚁','🚀','🛸','🏖️','🏝️','🏜️','🏔️','⛰️','🌋','🗻','🏕️','🏟️','🏛️','🏗️','🏘️','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','🌌','🌠','🗺️','🌍','🌎','🌏'] },
  { id: 'activities', icon: '⚽', emojis: ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🏒','⛳','🎣','🥊','🥋','🎽','🛷','🎿','⛷️','🏂','🏋️','🤼','🤸','⛹️','🤺','🤾','🏌️','🏇','🧘','🏄','🚵','🚴','🏆','🥇','🎪','🎭','🎨','🎬','🎤','🎧','🎼','🎵','🎶','🥁','🪘','🎷','🎺','🎸','🎻','🎲','♟️','🎯','🎳','🎮','🎰','🧩','🎈','🎉','🎊','🎁','🎀','🎗️','🎫','🎟️'] },
  { id: 'symbols', icon: '💡', emojis: ['✨','⭐','🌟','💫','🔥','💥','🎇','🎆','🌈','🌊','💧','💦','☁️','⛅','🌤️','🌪️','❄️','⛄','♻️','✅','❌','⭕','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','❓','❗','‼️','⁉️','💯','🔞','⚠️','⛔','🚫','🆗','🆙','🆒','🆕','🆓','🔔','🔕','🎵','🎶','⚡','💤','🔱','⚜️','🔰','✔️','☑️','🔶','🔷','🔸','🔹','🔺','🔻','🚩','🏁','🏳️','🏴','💠','🔲','🔳','◾','◽','◼️','◻️','🅰️','🅱️','🅾️','🆘','❤️','🧡','💛','💚','💙','💜'] },
]

const PER_CHAT_COLORS = [
  { id: 'default',  name: 'Default',  bg: null,      bubble: null,      recvBubble: null      },
  { id: 'rose',     name: 'Rose',     bg: '#1a0d12', bubble: '#5a1a36', recvBubble: '#3d0d24' },
  { id: 'ocean',    name: 'Ocean',    bg: '#0a1520', bubble: '#0e3356', recvBubble: '#0a2240' },
  { id: 'forest',   name: 'Forest',   bg: '#0a150e', bubble: '#1a3d22', recvBubble: '#0f2918' },
  { id: 'sunset',   name: 'Sunset',   bg: '#1a0e06', bubble: '#5c2e08', recvBubble: '#3d1e06' },
  { id: 'purple',   name: 'Purple',   bg: '#0f0a1a', bubble: '#2e1569', recvBubble: '#1e0d45' },
  { id: 'midnight', name: 'Midnight', bg: '#080c12', bubble: '#1a2035', recvBubble: '#111522' },
  { id: 'cherry',   name: 'Cherry',   bg: '#1a0808', bubble: '#5c1111', recvBubble: '#3d0a0a' },
]

const PER_CHAT_FONTS = [
  { id: 'default', name: 'Default', font: 'inherit' },
  { id: 'mono', name: 'Mono', font: '"Courier New", monospace' },
  { id: 'serif', name: 'Serif', font: 'Georgia, serif' },
  { id: 'rounded', name: 'Rounded', font: '"Arial Rounded MT Bold", "Nunito", sans-serif' },
  { id: 'large', name: 'Large', font: 'inherit', size: 16 },
]
const BOT_PATTERNS = [
  { re: /\b(hi|hello|hey|howdy|hola|greet)\b/i, r: ['Hello! 👋 How can I assist you today?', 'Hi there! 😊 What can I do for you?', 'Hey! Great to see you! 🌟 How can I help?'] },
  { re: /how are you|how r u/i, r: ["I'm doing fantastic! 😊 Ready to help.", 'Wonderful! 💪 What can I do for you?', "I'm great! Always here to assist you 🤖"] },
  { re: /\b(help|assist|support)\b/i, r: ['Sure! Here\'s what I can do:\n• Answer questions 💡\n• Tell jokes 😄\n• Check time ⏰\n• Give tips 📝\n\nWhat do you need?', 'Of course! Ask me anything 🤖\nTry: "joke", "tip", "time", or just chat!'] },
  { re: /\b(bye|goodbye|see you|cya|ttyl)\b/i, r: ['Goodbye! Have an amazing day! 👋', 'See you later! Stay awesome! 😊', 'Take care! Come back anytime 🌟'] },
  { re: /joke|funny|humor/i, r: [
    "Why do programmers prefer dark mode? Because light attracts bugs! 🐛😄",
    "Why don't scientists trust atoms? Because they make up everything! 😂",
    "I told my computer I needed a break. Now it won't stop sending me Kit-Kat ads 🍫😄",
    "What's a computer's favorite snack? Microchips! 🤖",
  ]},
  { re: /name|who are you|what are you/i, r: ["I'm SPVB AI Assistant! 🤖 Your smart companion built into SPVB — Smart Private Video Bridge.", "Call me SPVB Bot! 🤖 I'm here to chat, help, and keep you company."] },
  { re: /spvb/i, r: ['SPVB stands for Smart Private Video Bridge 🚀\nAll messages are E2E encrypted & auto-deleted after 24h! 🔒'] },
  { re: /time|clock|what time/i, r: [`Current time: ${new Date().toLocaleTimeString()} ⏰`, `It's ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} right now! ⏰`] },
  { re: /date|today|day/i, r: [`Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} 📅`] },
  { re: /weather|temperature/i, r: ["I can't check live weather, but you can search Google! 🌤️ Stay prepared!"] },
  { re: /tip|advice|suggestion/i, r: [
    "💡 Tip: Use end-to-end encryption in SPVB to keep your messages private!",
    "💡 Tip: Set a status update to let contacts know what you're up to!",
    "💡 Tip: You can make voice and video calls directly in SPVB! 📞📹",
  ]},
  { re: /feature|what can|capability/i, r: ['SPVB features:\n📨 E2E Encrypted chats\n📞 Voice calls\n📹 Video calls\n📊 Status updates (text + video)\n✉️ Gmail inbox\n🤖 AI chatbot (that\'s me!)\n👥 Contact sync'] },
  { re: /thank|thanks|ty\b/i, r: ["You're welcome! 😊 Happy to help!", "Anytime! 🌟 That's what I'm here for!", "My pleasure! 😄 Let me know if you need anything else!"] },
  { re: /love|like|amazing|great|awesome/i, r: ["Aww, thank you! 🥰 You're amazing too!", "That makes me happy! 😊 Anything else I can do for you?"] },
  { re: /sad|depressed|unhappy|bad day/i, r: ["I'm sorry to hear that 😢 Remember: every storm passes! You've got this 💪", "It's okay to feel down sometimes. Take a deep breath 🌸 I'm here for you!"] },
  { re: /bored|boring|nothing to do/i, r: ["Tell me a topic and I'll chat with you! 🎉 Or ask me for a joke 😄", "How about a challenge: Ask me the hardest question you know! 🤔"] },
  { re: /encrypt|private|secure|safe/i, r: ["All SPVB messages use AES-GCM 256-bit E2E encryption 🔒\nYour keys never leave your device!"] },
  { re: /call|video|voice/i, r: ["SPVB supports HD voice and video calls! 📞📹\nJust open a contact chat and tap the call buttons in the header!"] },
]

const BOT_QUICK_REPLIES = {
  default: ['👋 Say Hi', '😄 Tell a joke', '💡 Give a tip', '📋 Features', '⏰ Current time'],
  greeting: ['😄 Tell a joke', '💡 Give a tip', '📋 Features', '🔒 How is it secure?'],
  joke: ['😂 Another joke!', '💡 Give a tip', '👋 Say Hi'],
  help: ['📋 Features', '🔒 How is it secure?', '📞 Calling feature', '⏰ Current time'],
}

function getBotReply(msg) {
  for (const { re, r } of BOT_PATTERNS) { if (re.test(msg)) return r[Math.floor(Math.random() * r.length)] }
  const d = ["That's interesting! 🤔 Tell me more!", 'Got it! How else can I help? 💬', "I'm here if you need anything! 🤖", "Hmm, I'm still learning! 😊 Try asking me something else.", "Interesting! 🌟 What else would you like to know?"]
  return d[Math.floor(Math.random() * d.length)]
}

function getBotQuickReplies(msg) {
  if (/hi|hello|hey/i.test(msg)) return BOT_QUICK_REPLIES.greeting
  if (/joke|funny/i.test(msg)) return BOT_QUICK_REPLIES.joke
  if (/help|assist/i.test(msg)) return BOT_QUICK_REPLIES.help
  return BOT_QUICK_REPLIES.default
}
function nowTime() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }

function formatPhoneWithCode(phone) {
  if (!phone) return ''
  const d = phone.replace(/\D/g, '')
  if (d.length === 10) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`
  if (d.length === 11 && d.startsWith('0')) return `+91 ${d.slice(1, 6)} ${d.slice(6)}`
  return `+${d}`
}

function parseSpecialContent(text) {
  if (!text) return null
  if (text.startsWith('__location__|')) {
    const [, lat, lng, ...rest] = text.split('|')
    return { type: 'location', lat: parseFloat(lat), lng: parseFloat(lng), name: rest.join('|') || 'Location' }
  }
  if (text.startsWith('__contact__|')) {
    const [, name, phone, email] = text.split('|')
    return { type: 'contact', name: name || '', phone: phone || '', email: email || '' }
  }
  if (text.startsWith('__gif__|')) {
    const url = text.slice('__gif__|'.length)
    return { type: 'gif', url }
  }
  return null
}

const INIT_BOT_MSGS = [{ id: 1, text: "Hello! I'm SPVB AI Assistant. Ask me anything! 🤖", sent: false, time: 'Just now', read: true }]

// Render message text with clickable blue links (like WhatsApp).
// Creates a fresh regex per call — avoids lastIndex bug with global /g flag
// that causes missed matches when the same regex object is reused across renders.
function linkifyText(text) {
  if (!text) return text
  const re = /https?:\/\/[^\s<>"]+|www\.[^\s<>"]+/gi
  if (!re.test(text)) return text
  re.lastIndex = 0  // reset after .test() advanced it
  const parts = []; let last = 0; let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const href = m[0].startsWith('http') ? m[0] : `https://${m[0]}`
    parts.push(<a key={m.index} href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#53bdeb', textDecoration: 'underline', wordBreak: 'break-all' }} onClick={e => e.stopPropagation()}>{m[0]}</a>)
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export default function Dashboard({ onLogout, onLogin, bioRegistered: _bioRegistered, onRegisterBiometric, bioSupported: _bioSupported }) {
  const navigate = useNavigate()
  const [user, setUser] = useState(() => {
    try {
      const u = localStorage.getItem('user')
      if (!u || u === 'null' || u === 'undefined') return null
      const parsed = JSON.parse(u)
      return (parsed && typeof parsed === 'object' && (parsed.id || parsed.email)) ? parsed : null
    } catch { return null }
  })

  /* ── Contacts ── */
  const [spvbContacts, setSpvbContacts] = useState([])
  const [googleContacts, setGoogleContacts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('google_contacts') || '[]') } catch { return [] }
  })
  const [contactsLoading, setContactsLoading] = useState(false)
  const [savedContactIds, setSavedContactIds] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('saved_contacts') || '[]')) } catch { return new Set() }
  })

  /* ── Messages: bot=local, others=live ── */
  const [botMsgs, setBotMsgs] = useState(INIT_BOT_MSGS)
  const [liveMessages, setLiveMessages] = useState(() => {
    try {
      const storedUser = JSON.parse(localStorage.getItem('user') || '{}')
      const uid = storedUser?.id
      if (!uid) return {}
      const retDays = storedUser?.msg_retention_days ?? 1
      const stored = JSON.parse(localStorage.getItem(`msgs_${uid}`) || '{}')
      const cutoff = retDays > 0 ? Date.now() - retDays * 24 * 60 * 60 * 1000 : 0
      const cleaned = {}
      for (const [id, msgs] of Object.entries(stored)) {
        cleaned[id] = (msgs || [])
          .filter(m => !m.created_at || cutoff === 0 || new Date(m.created_at).getTime() > cutoff)
          .map(m => ({ ...m, pending: false }))
      }
      return cleaned
    } catch { return {} }
  })
  const [recentConversations, setRecentConversations] = useState(() => {
    try {
      const uid = JSON.parse(localStorage.getItem('user') || '{}')?.id
      if (!uid) return {}
      return JSON.parse(localStorage.getItem(`recent_${uid}`) || '{}')
    } catch { return {} }
  })
  const [unreadCounts, setUnreadCounts] = useState({}) // { contactId: number }

  /* ── UI state ── */
  const [activeId, setActiveId] = useState(null)
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [showEmoji, setShowEmoji] = useState(false)
  const [activeCall, setActiveCall] = useState(null)
  const [callOfflineContact, setCallOfflineContact] = useState(null) // {contact, type} when target is offline
  const [pendingRingtoneUpload, setPendingRingtoneUpload] = useState(null) // {dataUrl, fileName} waiting for save-as choice
  const [playingAudioId, setPlayingAudioId] = useState(null) // message id of currently playing voice msg
  const [callMinimized, setCallMinimized] = useState(false)
  const [incomingCall, setIncomingCall] = useState(null)
  const [showAddContact, setShowAddContact] = useState(false)
  const [mobileShowChat, setMobileShowChat] = useState(false)
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const [botTyping, setBotTyping] = useState(false)
  const [tab, setTab] = useState('chats')
  const tabSwipeStartX = useRef(null)
  const tabSwipeStartY = useRef(null)
  const TABS = ['chats', 'status', 'calls', 'mail']
  const [showSettings, setShowSettings] = useState(false)
  const [settingsPage, setSettingsPage] = useState(null) // null|'account'|'chats'|'notifications'|'privacy'|'help'|'devices'|'storage'
  const [showSwitchAccountDropdown, setShowSwitchAccountDropdown] = useState(false)
  const [onlineMap, setOnlineMap] = useState({})
  const lastSeenRef = useRef({}) // tracks last time each user was seen online (locally observed)
  const [showStatusModal, setShowStatusModal] = useState(false)
  const [myStatus, setMyStatus] = useState('')
  const [statusUpdates, setStatusUpdates] = useState([]) // my own statuses (local + backend)
  const [contactStatuses, setContactStatuses] = useState([]) // other users' status groups
  const [viewingStatusGroups, setViewingStatusGroups] = useState(null)
  const [viewingStatusStart, setViewingStatusStart] = useState(0)
  const [statusPosting, setStatusPosting] = useState(false) // uploading indicator
  const [statusPostProgress, setStatusPostProgress] = useState(0)
  const [showContactInfo, setShowContactInfo] = useState(false)
  const [showProfileImagePopup, setShowProfileImagePopup] = useState(false)
  const [profilePopupContact, setProfilePopupContact] = useState(null) // contact shown in profile popup
  const [replyTo, setReplyTo] = useState(null) // { id, text, sent, media_url, media_type, fileName }
  const [hoveredMsgId, setHoveredMsgId] = useState(null)
  const [msgMenuId, setMsgMenuId] = useState(null) // which message has dropdown open
  const [msgMenuPos, setMsgMenuPos] = useState({ x: 0, y: 0 }) // fixed position for dropdown
  const [mobileMsgMenu, setMobileMsgMenu] = useState(null) // mobile bottom-sheet context menu
  const [swipeState, setSwipeState] = useState({}) // { [msgId]: swipeX }
  const longPressTimer = useRef(null)
  const swipeStartX = useRef(null)
  const swipeStartY = useRef(null)
  const isMobile = () => window.matchMedia('(pointer: coarse)').matches
  const [deleteConfirmMsg, setDeleteConfirmMsg] = useState(null) // message pending delete confirmation
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [locationLoading, setLocationLoading] = useState(false)
  const [showContactPicker, setShowContactPicker] = useState(false)
  const [showForwardPicker, setShowForwardPicker] = useState(false)
  const [forwardMsg, setForwardMsg] = useState(null)

  /* ── Call logs ── */
  const [callLogs, setCallLogs] = useState([])
  const [syncingContacts, setSyncingContacts] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')

  /* ── E2E Encryption ── */
  const e2ePrivKeyRef = useRef(null)   // my ECDH private CryptoKey (v1 legacy)
  const e2ePubKeyJwkRef = useRef(null) // my public key JWK string (uploaded to server)
  const contactPubKeysRef = useRef({}) // { userId: jwkString } — their public keys
  const e2eReadyRef = useRef(false)    // true once key pair loaded from IndexedDB
  // V2 RSA-OAEP master key refs
  const v2PrivKeyRef = useRef(null)    // my RSA-OAEP private CryptoKey (for unwrapping per-message AES keys)
  const v2PubKeyRef  = useRef(null)    // my RSA-OAEP public CryptoKey (for wrapping)
  const liveMessagesRef = useRef({})   // mirrors liveMessages for sync access in async callbacks
  const [isDecryptingMessages, setIsDecryptingMessages] = useState(false)
  const [decryptGaveUp, setDecryptGaveUp] = useState(false) // true after 20s if still encrypted
  const [e2ePasswordNeeded, setE2ePasswordNeeded] = useState(false)
  const [e2ePasswordInput, setE2ePasswordInput] = useState('')
  const [e2ePasswordError, setE2ePasswordError] = useState('')
  const [e2ePasswordLoading, setE2ePasswordLoading] = useState(false)
  const [passwordValidated, setPasswordValidated] = useState(false) // Track if password was validated (show checkmark)
  const [decryptingMessages, setDecryptingMessages] = useState(false) // Track if messages are being decrypted
  const e2eBackupRef = useRef(null) // cached backup blob when password prompt is shown

  /* ── Typing indicators ── */
  const [typingUsers, setTypingUsers] = useState({}) // { userId: true }
  const typingTimersRef = useRef({})
  const typingThrottleRef = useRef(null)

  /* ── Dark / Light mode + fonts ── */
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('dark_mode') !== 'light')
  const [appFont, setAppFont] = useState(() => localStorage.getItem('app_font') || 'default')

  /* ── Profile edit ── */
  const [editName, setEditName] = useState('')
  const [editAbout, setEditAbout] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editRetention, setEditRetention] = useState(0)
  const [editSaving, setEditSaving] = useState(false)
  const [editSaveMsg, setEditSaveMsg] = useState(null) // { ok: bool, text: string }
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [coverUploading, setCoverUploading] = useState(false)
  const [showQuickProfile, setShowQuickProfile] = useState(false)
  const [editingNickname, setEditingNickname] = useState(null)
  const [nicknameInput, setNicknameInput] = useState('')
  const [nicknames, setNicknames] = useState({})
  const [blockedIds, setBlockedIds] = useState(new Set())
  const [seenStatusUsers, setSeenStatusUsers] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('seen_status_users') || '[]')) } catch { return new Set() }
  }) // userIds whose statuses we've viewed — persisted in localStorage

  const fetchStatusesRef = useRef(null) // ref so postStatus() can trigger a refresh

  /* ── Video status ── */
  const [statusPostType, setStatusPostType] = useState('text')
  const [statusVideoFile, setStatusVideoFile] = useState(null)
  const [statusVideoUrl, setStatusVideoUrl] = useState(null)
  const [statusImageFile, setStatusImageFile] = useState(null)
  const [statusImageUrl, setStatusImageUrl] = useState(null)
  const statusImageInputRef = useRef(null)
  const [statusVideoError, setStatusVideoError] = useState('')
  const [statusEmojiOpen, setStatusEmojiOpen] = useState(false)
  const [statusBgColor, setStatusBgColor] = useState('#075e54')
  const statusVideoInputRef = useRef(null)

  /* ── Bot quick replies ── */
  const [botQuickReplies, setBotQuickReplies] = useState(BOT_QUICK_REPLIES.default)
  const [smartRepliesLoading, setSmartRepliesLoading] = useState(false)

  /* ── Google connect (for email users) ── */
  const [googleConnecting, setGoogleConnecting] = useState(false)
  const [googleConnectDone, setGoogleConnectDone] = useState(() => isGoogleUser())

  /* ── In-app toast notification ── */
  const [inAppToast, setInAppToast] = useState(null) // { name, text, contactId, color }
  const toastTimerRef = useRef(null)
  const pendingToastsRef = useRef([]) // toasts that arrived while page was hidden

  /* ── Settings toggles ── */
  const [notifEnabled, setNotifEnabled] = useState(() => localStorage.getItem('notif_enabled') !== 'off')
  const [notifSound, setNotifSound] = useState(() => localStorage.getItem('notif_sound') !== 'off')
  const notifSoundRef = useRef(localStorage.getItem('notif_sound') !== 'off')
  // Global message ringtone (used when no per-contact ringtone is set)
  const [msgRingtone, setMsgRingtone] = useState(() => localStorage.getItem('msg_ringtone') || 'default')
  const msgRingtoneRef = useRef(localStorage.getItem('msg_ringtone') || 'default')
  // Incoming call ringtone (the looping ring sound)
  const [callRingtone, setCallRingtone] = useState(() => localStorage.getItem('call_ringtone') || 'call')
  const callRingtoneRef = useRef(localStorage.getItem('call_ringtone') || 'call')
  const ringtoneRef   = useRef(null) // AudioContext loop for incoming call ringtone
  const [contactRingtones, setContactRingtones] = useState(() => {
    try { return JSON.parse(localStorage.getItem('contact_ringtones') || '{}') } catch { return {} }
  })

  // Play per-contact notification sound (falls back to global msgRingtone)
  const _playNotifSound = (fromContactId) => {
    if (!notifSoundRef.current) return
    const perContact = fromContactId ? contactRingtones[String(fromContactId)] : null
    const tone = perContact || msgRingtoneRef.current || 'default'
    playRingtone(tone)
  }

  // Play looping incoming call ringtone (uses callRingtone setting)
  const _playRingtone = () => {
    _stopRingtone()
    const toneId = callRingtoneRef.current || 'call'
    // 'call' = built-in classic phone ring; otherwise use the selected ringtone on a loop
    if (toneId === 'call') {
      try {
        const ctx = new AudioContext()
        ringtoneRef.current = ctx
        const ring = () => {
          if (!ringtoneRef.current) return
          const sr = ctx.sampleRate
          const buf = ctx.createBuffer(1, sr * 0.6, sr)
          const ch = buf.getChannelData(0)
          for (let i = 0; i < ch.length; i++) {
            const t = i / sr
            ch[i] = (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) *
                    (t < 0.3 ? 1 : 0) * 0.28
          }
          const src = ctx.createBufferSource()
          const gain = ctx.createGain(); gain.gain.value = 0.7
          src.buffer = buf; src.connect(gain); gain.connect(ctx.destination)
          src.start()
          src.onended = ring
        }
        ring()
      } catch {}
    } else if (toneId !== 'none') {
      // Use selected ringtone in a repeating loop via timeout
      try {
        ringtoneRef.current = true // mark as active (non-AudioContext path)
        const loopPlay = () => {
          if (!ringtoneRef.current) return
          if (toneId === 'custom_call') {
            const dataUrl = localStorage.getItem('custom_call_ringtone_data')
            if (dataUrl) {
              try {
                // Stop any previous instance before starting new one
                if (ringtoneRef._currentAudio) { try { ringtoneRef._currentAudio.pause(); ringtoneRef._currentAudio.currentTime = 0 } catch {} }
                const a = new Audio(dataUrl); a.volume = 0.85
                ringtoneRef._currentAudio = a
                a.onended = () => { if (ringtoneRef.current) { ringtoneRef._loopTimer = setTimeout(loopPlay, 600) } }
                a.play().catch(() => {})
              } catch {}
              return // timing handled by onended
            }
          } else {
            playRingtone(toneId)
          }
          ringtoneRef._loopTimer = setTimeout(loopPlay, 1600)
        }
        loopPlay()
      } catch {}
    }
  }

  const _stopRingtone = () => {
    if (ringtoneRef._loopTimer) { clearTimeout(ringtoneRef._loopTimer); ringtoneRef._loopTimer = null }
    if (ringtoneRef._currentAudio) {
      try { ringtoneRef._currentAudio.pause(); ringtoneRef._currentAudio.currentTime = 0 } catch {}
      ringtoneRef._currentAudio = null
    }
    if (ringtoneRef.current) {
      if (typeof ringtoneRef.current === 'object' && ringtoneRef.current.close) {
        try { ringtoneRef.current.close() } catch {}
      }
      ringtoneRef.current = null
    }
  }
  const [showLastSeen, setShowLastSeen] = useState(() => localStorage.getItem('show_last_seen') !== 'off')
  const [showOnlineStatus, setShowOnlineStatus] = useState(() => localStorage.getItem('show_online_status') !== 'off')
  const [readReceipts, setReadReceipts] = useState(() => localStorage.getItem('read_receipts') !== 'off')
  const [chatTheme, setChatTheme] = useState(() => localStorage.getItem('chat_theme') || 'green')
  const THEMES = {
    green: '#00a884', blue: '#4285f4', purple: '#7c4dff', orange: '#f39c12',
    teal: '#00bcd4', rose: '#e91e63', amber: '#ff9800', indigo: '#3f51b5',
    emerald: '#10b981', crimson: '#dc2626',
  }
  const PREMIUM_THEMES = [
    { id: 'whatsapp', label: 'WhatsApp', gradient: 'linear-gradient(135deg, #00a884 0%, #25d366 100%)', accent: '#00a884' },
    { id: 'telegram', label: 'Telegram', gradient: 'linear-gradient(135deg, #2196f3 0%, #0d8ecf 100%)', accent: '#2196f3' },
    { id: 'instagram', label: 'Instagram', gradient: 'linear-gradient(135deg, #833ab4 0%, #fd1d1d 50%, #fcb045 100%)', accent: '#fd1d1d' },
    { id: 'midnight', label: 'Midnight', gradient: 'linear-gradient(135deg, #141e30 0%, #243b55 100%)', accent: '#6c63ff' },
    { id: 'aurora', label: 'Aurora', gradient: 'linear-gradient(135deg, #00c9ff 0%, #92fe9d 100%)', accent: '#00c9ff' },
    { id: 'sunset', label: 'Sunset', gradient: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', accent: '#f5576c' },
    { id: 'ocean', label: 'Ocean', gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', accent: '#667eea' },
    { id: 'forest', label: 'Forest', gradient: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)', accent: '#11998e' },
  ]
  const APP_FONTS = [
    { id: 'default', label: 'Default', family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
    { id: 'rounded', label: 'Rounded', family: "'Nunito', 'Varela Round', sans-serif" },
    { id: 'mono', label: 'Mono', family: "'Fira Code', 'Courier New', monospace" },
    { id: 'serif', label: 'Serif', family: "'Georgia', 'Times New Roman', serif" },
    { id: 'modern', label: 'Modern', family: "'Inter', 'Roboto', sans-serif" },
  ]

  // Per-chat themes (color + font, keyed by contactId, stored locally per user)
  const [chatThemes, setChatThemes] = useState(() => {
    try { const uid = JSON.parse(localStorage.getItem('user') || '{}').id; return JSON.parse(localStorage.getItem(`chatThemes_${uid}`) || '{}') } catch { return {} }
  })
  const [showChatThemeModal, setShowChatThemeModal] = useState(false)
  const [showHeaderMenu, setShowHeaderMenu] = useState(false)

  // Individual chat lock
  const [lockedChats, setLockedChats] = useState(() => {
    try { const uid = JSON.parse(localStorage.getItem('user') || '{}').id; return new Set(JSON.parse(localStorage.getItem(`lockedChats_${uid}`) || '[]')) } catch { return new Set() }
  })
  const [chatPins, setChatPins] = useState(() => {
    try { const uid = JSON.parse(localStorage.getItem('user') || '{}').id; return JSON.parse(localStorage.getItem(`chatPins_${uid}`) || '{}') } catch { return {} }
  })
  const [chatUnlocked, setChatUnlocked] = useState(new Set())
  const [showLockModal, setShowLockModal] = useState(false)
  const [lockModalMode, setLockModalMode] = useState('unlock') // 'unlock'|'set'|'remove'
  const [lockPinInput, setLockPinInput] = useState('')
  const [lockError, setLockError] = useState('')
  const [lockTarget, setLockTarget] = useState(null)
  // Modern lock overlay
  const [lockOverlayPinDigits, setLockOverlayPinDigits] = useState([])
  const [lockOverlayShake, setLockOverlayShake] = useState(false)
  const [biometricAvail, setBiometricAvail] = useState(false)
  // QR device linking
  const [showQrPanel, setShowQrPanel] = useState(false)
  const [qrToken, setQrToken] = useState(null)
  const [qrDataUrl, setQrDataUrl] = useState(null)
  const [qrStatus, setQrStatus] = useState('idle') // 'idle'|'generating'|'ready'|'scanned'|'approved'|'rejected'|'expired'
  const [qrLinkRequest, setQrLinkRequest] = useState(null) // {token, device_name} approval request
  const [linkedDevices, setLinkedDevices] = useState([])
  // QR scanner (mobile: scan desktop QR to approve login)
  const [showQrScanner, setShowQrScanner] = useState(false)
  const [qrScanError, setQrScanError] = useState('')
  const [qrScanStatus, setQrScanStatus] = useState('idle') // idle|scanning|approving|done|error
  const qrVideoRef = useRef(null)
  const qrStreamRef = useRef(null)
  const qrScanRafRef = useRef(null)

  // Enhanced emoji picker
  const [emojiCategory, setEmojiCategory] = useState(0)
  const [emojiSearch, setEmojiSearch] = useState('')
  const [emojiTab, setEmojiTab] = useState('emoji')
  const [gifSearch, setGifSearch] = useState('')
  const [gifs, setGifs] = useState([])
  const [gifLoading, setGifLoading] = useState(false)

  // Group chat
  const [groups, setGroups] = useState([])
  const [groupMessages, setGroupMessages] = useState({})
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupMembers, setNewGroupMembers] = useState([])

  /* ── Gmail ── */
  const [gmailToken, setGmailToken] = useState(() => {
    const t = localStorage.getItem('gmail_access_token')
    const exp = parseInt(localStorage.getItem('gmail_token_expiry') || '0')
    return t && Date.now() < exp ? t : null
  })
  const [mails, setMails] = useState([])
  const [mailLoading, setMailLoading] = useState(false)
  const [mailError, setMailError] = useState('')
  const [selectedMail, setSelectedMail] = useState(null)
  const [mailBodyLoading, setMailBodyLoading] = useState(false)

  const botMsgIdRef = useRef(1000)
  const botMsgsRef = useRef(INIT_BOT_MSGS)
  const nextBotId = () => { botMsgIdRef.current += 1; return botMsgIdRef.current }

  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)

  /* ── Feature: Archived Chats (#3) ── */
  const [archivedChats, setArchivedChats] = useState(() => { try { const uid = JSON.parse(localStorage.getItem('user') || '{}').id; return new Set(JSON.parse(localStorage.getItem(`archivedChats_${uid}`) || '[]')) } catch { return new Set() } })
  const [showArchivedList, setShowArchivedList] = useState(false)

  /* ── Feature: Starred Messages (#4) ── */
  const [starredMsgIds, setStarredMsgIds] = useState(() => { try { const uid = JSON.parse(localStorage.getItem('user') || '{}').id; return new Set(JSON.parse(localStorage.getItem(`starredMsgs_${uid}`) || '[]')) } catch { return new Set() } })
  const [showStarredPanel, setShowStarredPanel] = useState(false)

  /* ── Feature: Mentions (#6) ── */
  const [mentionSearch, setMentionSearch] = useState('')
  const [showMentionList, setShowMentionList] = useState(false)

  /* ── Feature: Polls (#7) ── */
  const [showPollModal, setShowPollModal] = useState(false)
  const [pollQuestion, setPollQuestion] = useState('')
  const [pollOptions, setPollOptions] = useState(['', ''])
  const [activePolls, setActivePolls] = useState({}) // msgId -> { question, options, votes:{optIdx:[userId]} }

  /* ── Feature: View-Once Media (#8) ── */
  const [viewOnceMode, setViewOnceMode] = useState(false)
  const [viewedOnceIds, setViewedOnceIds] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('viewedOnce') || '[]')) } catch { return new Set() } })
  const [pendingMediaFile, setPendingMediaFile] = useState(null) // { file, previewUrl, isImage }
  const [pendingMediaViewOnce, setPendingMediaViewOnce] = useState(false)
  // Crop modal state — used for both chat images and status images
  const [cropSrc, setCropSrc] = useState(null)          // image URL to crop
  const [cropCallback, setCropCallback] = useState(null) // fn(blob) called on Done

  /* ── Feature: Broadcast (#9) ── */
  const [showBroadcastModal, setShowBroadcastModal] = useState(false)
  const [broadcastRecipients, setBroadcastRecipients] = useState([])
  const [broadcastMsg, setBroadcastMsg] = useState('')
  const [broadcastSending, setBroadcastSending] = useState(false)

  /* ── Feature: Chat Labels (#10) ── */
  const [chatLabels, setChatLabels] = useState(() => { try { const uid = JSON.parse(localStorage.getItem('user') || '{}').id; return JSON.parse(localStorage.getItem(`chatLabels_${uid}`) || '{}') } catch { return {} } })
  const LABEL_DEFS = [{ id: 'unread', label: 'Unread', color: '#00a884' }, { id: 'work', label: 'Work', color: '#4285f4' }, { id: 'family', label: 'Family', color: '#e74c3c' }, { id: 'friends', label: 'Friends', color: '#f39c12' }, { id: 'important', label: 'Important', color: '#8e44ad' }]

  /* ── Feature: In-Chat Search (#12) ── */
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [chatSearchIdx, setChatSearchIdx] = useState(0)
  const chatSearchRef = useRef(null)

  /* ── Feature: Message Scheduling (#13) ── */
  const [showScheduler, setShowScheduler] = useState(false)
  const [scheduleTime, setScheduleTime] = useState('')
  const scheduledTimersRef = useRef([])

  /* ── Feature: Chat Wallpaper (#14) ── */
  const [chatWallpapers, setChatWallpapers] = useState(() => { try { const uid = JSON.parse(localStorage.getItem('user') || '{}').id; return JSON.parse(localStorage.getItem(`chatWallpapers_${uid}`) || '{}') } catch { return {} } })
  const [showWallpaperModal, setShowWallpaperModal] = useState(false)
  const WALLPAPER_PRESETS = [{ id: 'none', label: 'None', bg: '' }, { id: 'dots', label: 'Dots', bg: 'radial-gradient(circle, rgba(134,150,160,0.15) 1px, transparent 1px)', bgSize: '20px 20px' }, { id: 'grid', label: 'Grid', bg: 'linear-gradient(rgba(134,150,160,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(134,150,160,0.08) 1px, transparent 1px)', bgSize: '24px 24px' }, { id: 'stripes', label: 'Stripes', bg: 'repeating-linear-gradient(-45deg, transparent, transparent 10px, rgba(134,150,160,0.07) 10px, rgba(134,150,160,0.07) 11px)' }]

  /* ── Feature: Per-chat Disappearing (#15) ── */
  const [chatAutoDelete, setChatAutoDelete] = useState(() => { try { const uid = JSON.parse(localStorage.getItem('user') || '{}').id; return JSON.parse(localStorage.getItem(`chatAutoDelete_${uid}`) || '{}') } catch { return {} } })

  /* ── Feature: Multiple Accounts (#16) ── */
  const [savedAccounts, setSavedAccounts] = useState(() => {
    try {
      const accounts = JSON.parse(localStorage.getItem('spvb_accounts') || '[]')
      const removed  = new Set(JSON.parse(localStorage.getItem('spvb_removed_accounts') || '[]'))
      // Filter at init time — removes stale entries that survived before the blocklist was added
      const filtered = accounts.filter(a => !removed.has(String(a.id)))
      if (filtered.length !== accounts.length) {
        localStorage.setItem('spvb_accounts', JSON.stringify(filtered))
      }
      return filtered
    } catch { return [] }
  })
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(false)

  /* ── Feature: Forward Count (#17) ── */
  const [forwardCounts, setForwardCounts] = useState({}) // msgId -> count (local session only)

  const msgEndRef = useRef(null)
  const inputRef = useRef(null)
  const mediaInputRef = useRef(null)
  const docInputRef = useRef(null)
  const cameraInputRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const recordingTimerRef = useRef(null)
  const heartbeatRef = useRef(null)
  const pollRef = useRef(null)
  const wsRef = useRef(null)
  const wsHandlerRef = useRef(null)
  const pendingIceCandidatesRef = useRef([])
  const fetchMsgsRef = useRef(null)
  const fetchRecentRef = useRef(null)
  const spvbContactsRef = useRef([])
  const activeIdRef = useRef(null)
  // Refs that mirror activeCall/incomingCall so SW message handlers (closures) read current values
  const activeCallRef    = useRef(null)
  const incomingCallRef  = useRef(null)
  // Keep refs in sync with state so stale-closure handlers always see current values
  activeCallRef.current   = activeCall
  incomingCallRef.current = incomingCall
  const previewAudioRef = useRef(null)   // currently-playing preview sound in settings
  const currentAudioRef = useRef(null)   // currently-playing chat voice message

  const themeColor = THEMES[chatTheme] || PREMIUM_THEMES.find(t => t.id === chatTheme)?.accent || THEMES.green
  const _premiumTheme = PREMIUM_THEMES.find(t => t.id === chatTheme)
  const themeGradient = _premiumTheme ? _premiumTheme.gradient : themeColor

  /* ── Sync CSS custom properties so CSS classes pick up theme/gradient ── */
  useEffect(() => {
    document.documentElement.style.setProperty('--theme-color', themeColor)
    document.documentElement.style.setProperty('--theme-gradient', themeGradient)
  }, [themeColor, themeGradient])

  /* ── Mobile back-button intercept (PWA / Android) ── */
  // Push ONE sentinel entry on mount only — not on every state change.
  // Re-pushing on every dependency change created phantom history entries
  // that made back presses appear to do nothing.
  useEffect(() => {
    window.history.pushState({ spvb: true }, '')
  }, []) // mount only

  useEffect(() => {
    const onPopState = () => {
      // Always re-push so we never exhaust history and the app never navigates away
      window.history.pushState({ spvb: true }, '')

      // Close overlays in priority order — most specific first
      if (mobileMsgMenu)         { setMobileMsgMenu(null);          return }
      if (msgMenuId)             { setMsgMenuId(null);              return }
      if (cropSrc)               { setCropSrc(null); setCropCallback(null); return }
      if (showProfileImagePopup) { setShowProfileImagePopup(false); setProfilePopupContact(null); return }
      if (showContactInfo)       { setShowContactInfo(false);       return }
      if (showSettings)          { setShowSettings(false);          return }
      if (showAddContact)        { setShowAddContact(false);        return }
      if (mobileShowChat)        { setMobileShowChat(false); setActiveId(null); return }
      // Nothing to close — back press is absorbed (app stays open)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [mobileMsgMenu, msgMenuId, cropSrc, showProfileImagePopup, showContactInfo, showSettings, showAddContact, mobileShowChat])

  /* ── Mobile keyboard height tracking via visualViewport ── */
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const kbH = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      setKeyboardHeight(kbH)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])

  /* ── E2E key init — generate/load key pair and upload public key ── */
  useEffect(() => {
    if (!user?.id) return
    if (!window.isSecureContext || !window.crypto?.subtle) return // crypto.subtle requires HTTPS
    const token = localStorage.getItem('token')
    const pw = sessionStorage.getItem('e2e_pw')
    const userId = user.id

    // Backup callbacks: fetch/upload encrypted private key from server so other devices can restore
    const fetchBackup = pw ? async () => {
      // Retry up to 3 times with short backoff — covers Render cold-start (max ~4s total)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500)) // 1.5s, 3s
          const res = await fetch(apiUrl('/api/users/me/key-backup'), {
            headers: { Authorization: `Bearer ${token}` }
          })
          if (!res.ok) {
            if (res.status === 401) return null // auth failure — no point retrying
            continue // server error — retry
          }
          const { backup } = await res.json()
          if (!backup) return null // genuinely no backup — fresh account
          return await importKeyBackup(backup, pw, userId)
        } catch { /* network error — retry */ }
      }
      return null
    } : undefined

    const uploadBackup = pw ? async (privKeyJwk) => {
      const backup = await exportKeyBackup(privKeyJwk, pw, userId)
      await fetch(apiUrl('/api/users/me/key-backup'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ backup }),
      })
    } : undefined

    getOrCreateKeyPair({ fetchBackup, uploadBackup, userId }).then(async ({ privateKey, publicKeyJwk, privateKeyJwk, restoredFromBackup }) => {
      // ── Step 1: Store key in memory refs ────────────────────────────────
      e2ePrivKeyRef.current  = privateKey
      e2ePubKeyJwkRef.current = publicKeyJwk
      e2eReadyRef.current    = true
      localStorage.setItem(`e2e_ready_${userId}`, '1')
      sessionStorage.removeItem('e2e_pw')

      const localX = (() => { try { return JSON.parse(publicKeyJwk).x } catch { return null } })()
      console.log(`[E2E] Key loaded | source=${restoredFromBackup ? 'IndexedDB/backup' : 'fresh-generated'} | pubkey-x=${localX?.slice(0,8)}…`)

      // ── Step 2: Upload backup (password users only, non-blocking) ────────
      if (uploadBackup && privateKeyJwk) {
        uploadBackup(privateKeyJwk)
          .then(() => console.log('[E2E] Backup uploaded ✅'))
          .catch(err => console.warn('[E2E] Backup upload failed:', err?.message))
      }

      // ── Step 3: Sync pubkey to server — ALWAYS, every login ──────────────
      // Fetch what server has and compare. If mismatch or missing → re-upload.
      // This is the most reliable fix for "key in IndexedDB but messages won't decrypt"
      fetch(apiUrl(`/api/users/${userId}/pubkey`), { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : null)
        .then(async data => {
          const serverX = data?.pubkey ? (() => { try { return JSON.parse(data.pubkey).x } catch { return null } })() : null
          if (!serverX) {
            // Server has no pubkey — upload local key
            console.warn('[E2E] No pubkey on server — uploading now')
            await fetch(apiUrl('/api/users/me/pubkey'), { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pubkey: publicKeyJwk }) })
            console.log('[E2E] Pubkey uploaded ✅')
          } else if (serverX !== localX) {
            // Mismatch — check if server has a backup before overwriting
            // If backup exists, local key is WRONG (QR device with fresh key)
            // → show restore modal instead of overwriting server's correct key
            console.warn(`[E2E] Pubkey MISMATCH — server-x=${serverX?.slice(0,8)}… local-x=${localX?.slice(0,8)}…`)
            try {
              const bkRes = await fetch(apiUrl('/api/users/me/key-backup-v2'), { headers: { Authorization: `Bearer ${token}` } })
              const bkData = bkRes.ok ? await bkRes.json() : {}
              if (bkData.backup && bkData.backup.length > 10) {
                // Server has a backup → local key is wrong → restore from backup
                console.warn('[E2E] Server has backup — local key is wrong. Showing restore modal.')
                setE2ePasswordNeeded(true)
              } else {
                // No backup → local is authoritative → upload it
                await fetch(apiUrl('/api/users/me/pubkey'), { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pubkey: publicKeyJwk }) })
                console.log('[E2E] Pubkey re-synced ✅')
              }
            } catch {
              // Fallback: re-upload local key
              await fetch(apiUrl('/api/users/me/pubkey'), { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pubkey: publicKeyJwk }) })
            }
          } else {
            console.log(`[E2E] Server pubkey matches ✅ x=${serverX?.slice(0,8)}…`)
          }
        })
        .catch(err => console.warn('[E2E] Pubkey sync check failed:', err?.message))

      // ── Step 4: Schedule decryption passes ──────────────────────────────
      decryptAllPending(privateKey)
      setTimeout(() => decryptAllPending(privateKey), 800)
      setTimeout(() => decryptAllPending(privateKey), 2500)
      setTimeout(() => decryptAllPending(privateKey), 6000)
      setTimeout(() => decryptAllPending(privateKey), 12000)
      setTimeout(() => decryptAllPending(privateKey), 25000)
      setTimeout(() => decryptAllPending(privateKey), 60000)
      // After 20s still encrypted → show clean lock icon, not infinite spinner
      setTimeout(() => setDecryptGaveUp(true), 20000)

    }).catch(err => {
      console.error('[E2E] CRITICAL: key init failed — messages will not decrypt:', err?.message || err)
    })
  }, [user?.id])

  // Wait until E2E key pair is ready (max 30s — covers backup fetch retries on slow servers)
  const waitForE2eKey = () => new Promise(resolve => {
    if (e2eReadyRef.current) { resolve(); return }
    let waited = 0
    const t = setInterval(() => {
      waited += 100
      if (e2eReadyRef.current || waited >= 30000) { clearInterval(t); resolve() }
    }, 100)
  })

  // Decrypt all already-loaded messages that still contain raw cipher text.
  // Handles both V2 (RSA-OAEP wrapped key) and V1 (ECDH shared key) messages.
  const decryptAllPending = async (privKey) => {
    const key = privKey || e2ePrivKeyRef.current
    const v2Priv = v2PrivKeyRef.current
    if (!key && !v2Priv) return
    const snapshot = liveMessagesRef.current
    const myId = user?.id

    // Find contacts that have any encrypted messages (v1 or v2)
    const encryptedContacts = Object.entries(snapshot).filter(([, msgs]) =>
      msgs.some(m => {
        const t = String(m.text || '')
        return t.startsWith('__e2e__|') || t.startsWith('__e2ev2__|') || m._encrypted
      })
    )
    if (encryptedContacts.length === 0) return

    try {
      // Fetch ALL contact public keys IN PARALLEL
      const pubKeyResults = await Promise.all(
        encryptedContacts.map(([contactId]) =>
          getContactPubKey(contactId).then(pub => ({ contactId, pub }))
        )
      )

      let anyKeyMissing = false

      // Decrypt ALL contacts IN PARALLEL
      await Promise.all(pubKeyResults.map(async ({ contactId, pub }) => {
        if (!pub && !v2Priv) { anyKeyMissing = true; return }
        const msgs = snapshot[contactId]
        const decrypted = await Promise.all(msgs.map(async m => {
          const txt = String(m.text || '')
          const isEncrypted = txt.startsWith('__e2e__|') || txt.startsWith('__e2ev2__|') || m._encrypted
          if (!isEncrypted) return m
          // V2: message has wrapped keys — use RSA-OAEP unwrap
          if (v2Priv && isV2Message(m._raw || m)) {
            const raw = m._raw || m
            const isSender  = raw.from_user_id === myId
            const wrappedKey = isSender ? raw.encrypted_key_for_sender : raw.encrypted_key_for_receiver
            if (!wrappedKey) return m
            const plain = await decryptMessageWithWrappedKey(m.text, wrappedKey, v2Priv)
            const stillCipher = String(plain || '').startsWith('__e2e') || String(plain || '').startsWith('__e2ev2')
            return { ...m, text: plain, _encrypted: stillCipher }
          }
          // V1: ECDH shared key fallback
          if (!key || !pub) return m
          const plain = await decryptMessage(m.text, key, pub)
          const stillCipher = String(plain || '').startsWith('__e2e')
          return { ...m, text: plain, _encrypted: stillCipher }
        }))
        setLiveMessages(prev => {
          const current = prev[contactId]
          if (!current) return prev
          const decById = new Map(decrypted.map(m => [m.id, m]))
          return {
            ...prev,
            [contactId]: current.map(m =>
              String(m.text || '').startsWith('__e2e__|') ? (decById.get(m.id) || m) : m
            )
          }
        })
      }))

      if (anyKeyMissing) {
        setTimeout(() => decryptAllPending(key), 2000)
        setTimeout(() => decryptAllPending(key), 6000)
      }
    } catch { /* non-fatal */ }
  }

  // Load V2 RSA-OAEP master key pair from IndexedDB — with retry in case
  // setupMasterKeyAfterLogin is still running in the background on first load
  useEffect(() => {
    // Don't wait for user?.id — token is sufficient for auth after QR login
    const tok = localStorage.getItem('token')
    if (!tok) {
      console.log('[E2Ev2] No token yet, waiting...')
      return
    }

    console.log('[E2Ev2] ✅ Token available, starting password modal check...')

    // Get user ID from user object OR extract from JWT token
    let uid = user?.id
    if (!uid && tok) {
      try {
        const parts = tok.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1]))
          uid = payload.user_id || payload.sub
          if (uid) console.log('[E2Ev2] Extracted user ID from JWT:', uid)
        }
      } catch (err) {
        console.warn('[E2Ev2] Could not extract UID from JWT:', err?.message)
      }
    }

    if (!uid) {
      console.warn('[E2Ev2] No user ID available, skipping...')
      return
    }

    const uid_str = String(uid)
    const tryLoad = async (attemptsLeft) => {
      try {
        const kp = await loadMasterKeyPair(uid_str)
        if (kp) {
          v2PrivKeyRef.current = kp.privateKey
          v2PubKeyRef.current  = kp.publicKey
          console.log('[E2Ev2] Master key loaded from IndexedDB ✅')
          // Trigger decryption now that key is available
          const privKey = e2ePrivKeyRef.current
          setTimeout(() => decryptAllPending(privKey), 300)
          return
        }
        if (attemptsLeft > 0) {
          // Key not ready yet — setupMasterKeyAfterLogin may still be running
          setTimeout(() => tryLoad(attemptsLeft - 1), 800)
        } else {
          // RSA key not in IndexedDB — check if server has a backup to restore
          console.warn('[E2Ev2] Master key not found — checking server for backup...')
          try {
            const tok = localStorage.getItem('token')
            const res = await fetch(apiUrl('/api/users/me/key-backup-v2'), {
              headers: { Authorization: `Bearer ${tok}` }
            })
            console.log('[E2Ev2] Backup check response status:', res.status)
            if (res.ok) {
              const { backup } = await res.json()
              console.log('[E2Ev2] Backup data received, length:', backup?.length)
              // ⚠️ LOGIC: Show modal ONLY for QR/Google login, NOT for direct password login
              const pw = sessionStorage.getItem('e2e_pw')
              const directPasswordLogin = pw // User logged in with username/password
              const isQrOrGoogleLogin = !pw // User logged in with QR or Google (no password)

              if (backup && backup.length > 10) {
                // Server has backup
                if (directPasswordLogin) {
                  // Direct password login: restore silently, NO modal
                  console.log('[E2Ev2] ✅ Direct password login - restoring backup silently')
                  setupMasterKeyAfterLogin({ userId: uid_str, password: pw, token: tok, apiUrl })
                    .then(kp => {
                      if (kp) { v2PrivKeyRef.current = kp.privateKey; v2PubKeyRef.current = kp.publicKey }
                    }).catch(err => {
                      console.error('[E2Ev2] Backup restore failed:', err?.message)
                    })
                } else if (isQrOrGoogleLogin) {
                  // QR/Google login: show modal ONCE to verify password
                  const alreadyAsked = sessionStorage.getItem('e2e_password_validation_shown')
                  if (!alreadyAsked) {
                    console.log('[E2Ev2] ✅ QR/Google login - showing password validation modal ONCE')
                    setE2ePasswordNeeded(true)
                  }
                }
              } else {
                // No backup
                if (directPasswordLogin) {
                  console.log('[E2Ev2] Direct password login - no modal')
                  setupMasterKeyAfterLogin({ userId: uid_str, password: pw, token: tok, apiUrl })
                    .then(kp => {
                      if (kp) { v2PrivKeyRef.current = kp.privateKey; v2PubKeyRef.current = kp.publicKey }
                    }).catch(() => {})
                } else if (isQrOrGoogleLogin) {
                  // QR/Google login with no backup: show modal once
                  const alreadyAsked = sessionStorage.getItem('e2e_password_validation_shown')
                  if (!alreadyAsked) {
                    console.log('[E2Ev2] QR/Google login, no backup - showing password validation modal')
                    setE2ePasswordNeeded(true)
                  }
                }
              }
            } else {
              console.warn('[E2Ev2] Backup check failed with status:', res.status)
            }
          } catch (err) {
            console.warn('[E2Ev2] Backup check failed:', err?.message)
          }
        }
      } catch (err) {
        console.warn('[E2Ev2] loadMasterKeyPair error:', err?.message)
      }
    }
    tryLoad(6) // retry up to 6 times = ~5 seconds total
  }, []) // Empty dependency - runs once, relies on token from localStorage

  // Restore BOTH V1 ECDH + V2 RSA keys from backup using the user's password
  // OR setup new encryption password for Google users with no backup
  const restoreE2eKeyWithPassword = async (password) => {
    setE2ePasswordLoading(true)
    setE2ePasswordError('')
    try {
      const tok = localStorage.getItem('token')
      const uid = user?.id
      const isGoogle = localStorage.getItem('google_auth') === 'true'

      // Check if there's a server backup to restore
      const backupRes = await fetch(apiUrl('/api/users/me/key-backup-v2'), {
        headers: { Authorization: `Bearer ${tok}` }
      })
      const backupData = await backupRes.json().catch(() => ({}))
      const hasBackup = backupData.backup && backupData.backup.length > 10

      if (!hasBackup && isGoogle) {
        // Google user with no backup — setup new encryption key
        console.log('[E2Ev2] Google user setting up new encryption key...')
        sessionStorage.setItem('e2e_pw', password)
        const kp = await setupMasterKeyAfterLogin({ userId: uid, password, token: tok, apiUrl })
        if (!kp) throw new Error('Key setup failed')
        v2PrivKeyRef.current = kp.privateKey
        v2PubKeyRef.current = kp.publicKey
        console.log('[E2Ev2] New RSA encryption key setup ✅')
      } else if (hasBackup) {
        // Has backup — restore from it
        console.log('[E2Ev2] Restoring from server backup...')
        // CRITICAL: delete any wrong fresh key from IndexedDB first
        await deleteMasterKeyPair(String(uid))
        await deleteStoredKeyPair(uid)
        console.log('[E2Ev2] Cleared wrong IndexedDB keys')

        // Restore V2 RSA key from server backup using password
        const kp = await setupMasterKeyAfterLogin({ userId: uid, password, token: tok, apiUrl })
        if (!kp) throw new Error('Backup restore failed — check your password')
        v2PrivKeyRef.current = kp.privateKey
        v2PubKeyRef.current = kp.publicKey
        console.log('[E2Ev2] RSA key restored from password ✅')

        // Restore V1 ECDH key from server backup
        try {
          const r = await fetch(apiUrl('/api/users/me/key-backup'), { headers: { Authorization: `Bearer ${tok}` } })
          if (r.ok) {
            const { backup } = await r.json()
            if (backup) {
              const { privateKey, publicKeyJwk } = await replaceKeyPairFromBackup(backup, password, uid)
              e2ePrivKeyRef.current = privateKey
              e2ePubKeyJwkRef.current = publicKeyJwk
              console.log('[E2E] V1 ECDH key restored ✅')
            }
          }
        } catch { /* V1 restore optional */ }
      }

      contactPubKeysRef.current = {}
      localStorage.setItem(`e2e_ready_${uid}`, '1')
      sessionStorage.setItem('e2e_pw', password)
      sessionStorage.setItem('e2e_password_validation_shown', '1') // Mark validation complete - don't show modal again

      // Show checkmark for 1 second, then start message decryption
      setPasswordValidated(true)
      console.log('[PASSWORD] ✅ Password validated - showing checkmark')

      setTimeout(() => {
        setE2ePasswordNeeded(false)
        setE2ePasswordInput('')
        setDecryptingMessages(true) // Start full screen loading
        console.log('[DECRYPT] Starting message decryption...')

        // Trigger decryption immediately
        const v1Key = e2ePrivKeyRef.current
        if (v1Key) {
          setTimeout(() => {
            decryptAllPending(v1Key)
            setTimeout(() => {
              setDecryptingMessages(false) // Decryption complete
              setPasswordValidated(false)
              console.log('[DECRYPT] ✅ Messages decrypted - showing dashboard')
            }, 2000)
          }, 500)
        }
      }, 1500) // Show checkmark for 1.5 seconds

      e2eBackupRef.current = null

      // Trigger decryption with both keys now available
      const v1Key = e2ePrivKeyRef.current
      setTimeout(() => decryptAllPending(v1Key), 0)
      setTimeout(() => decryptAllPending(v1Key), 1500)
      setTimeout(() => decryptAllPending(v1Key), 4000)
      setTimeout(() => decryptAllPending(v1Key), 8000)
    } catch (err) {
      console.warn('[E2Ev2] Restore failed:', err?.message)
      setE2ePasswordError(err.message || 'Failed to setup encryption. Please try again.')
    }
    setE2ePasswordLoading(false)
  }

  /* ── Notification permission + push subscription ── */
  useEffect(() => {
    if (!user?.id || !('Notification' in window)) return
    const token = localStorage.getItem('token')

    // Store token in SW-accessible cache so inline reply can send messages without opening the app
    if (token && 'caches' in window) {
      caches.open('spvb-auth-v1').then(c => c.put('/sw-token', new Response(token))).catch(() => {})
    }

    const setup = async () => {
      // Step 1: request notification permission
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') return

      // Step 2: Web Push — HTTPS only
      const isSecure = location.protocol === 'https:' || location.hostname === 'localhost'
      if (!isSecure || !('serviceWorker' in navigator) || !('PushManager' in window)) return

      try {
        // Force SW to check for updates so new SW version activates immediately
        const reg = await navigator.serviceWorker.ready
        reg.update().catch(() => {})

        const keyRes = await fetch(apiUrl('/api/push/vapid-public-key'))
        if (!keyRes.ok) return
        const { publicKey } = await keyRes.json()
        if (!publicKey) return

        // Correct base64url → Uint8Array (must add padding or atob fails on Android)
        const b64 = (publicKey + '='.repeat((4 - publicKey.length % 4) % 4))
          .replace(/-/g, '+').replace(/_/g, '/')
        const vapidKey = Uint8Array.from(atob(b64), c => c.charCodeAt(0))

        // Always get-or-create subscription, then ALWAYS re-register with backend
        // (handles SW update, DB wipe, subscription expiry, device reinstall)
        let sub = await reg.pushManager.getSubscription()
        if (!sub) {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey })
        } else {
          // Verify subscription key matches current VAPID — re-subscribe if different
          try {
            const subKey = btoa(String.fromCharCode(...new Uint8Array(sub.options?.applicationServerKey || [])))
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
            if (subKey && publicKey && !publicKey.startsWith(subKey.slice(0, 10))) {
              await sub.unsubscribe()
              sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey })
            }
          } catch { /* keep existing sub */ }
        }

        // Always register with backend (idempotent upsert on server)
        await fetch(apiUrl('/api/push/subscribe'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(sub.toJSON()),
          keepalive: true,
        })
        console.log('[Push] registered OK:', sub.endpoint.slice(0, 55) + '…')
      } catch (err) {
        console.warn('[Push] setup failed:', err.message)
      }

      // Step 3: Firebase FCM — for Android/iOS/Web (runs in parallel if configured)
      try {
        const { initFirebase, getFCMToken } = await import('../firebase.js')
        const msg = initFirebase()
        if (msg) {
          // SW is already registered above (navigator.serviceWorker.ready).
          // Firebase config is baked into the SW at build time by vite.config.js,
          // so no postMessage needed — background notifications work even when closed.
          await navigator.serviceWorker.register('/firebase-messaging-sw.js')
          // Wait until a service worker is fully active before requesting FCM token.
          // Without this, getFCMToken() can return a token tied to an inactive SW,
          // causing push notifications to be silently dropped.
          await navigator.serviceWorker.ready
          const fcmToken = await getFCMToken()
          if (fcmToken) {
            await fetch(apiUrl('/api/push/fcm-token'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ token: fcmToken }),
            })
            // Store so logout() can remove it from the backend
            localStorage.setItem('fcm_token', fcmToken)
            console.log('[FCM] registered OK')
          }
        }
      } catch (fcmErr) {
        console.warn('[FCM] setup skipped:', fcmErr.message)
      }
    }

    setup()

    // On mobile browsers, Notification.requestPermission() needs a user gesture.
    // If permission is still "default" after first setup(), retry on next tap/click.
    let gestureSetupDone = false
    const onGesture = () => {
      if (gestureSetupDone || Notification.permission === 'granted') return
      gestureSetupDone = true
      setup()
      document.removeEventListener('click',      onGesture)
      document.removeEventListener('touchstart', onGesture)
    }
    if (Notification.permission === 'default') {
      document.addEventListener('click',      onGesture, { once: true })
      document.addEventListener('touchstart', onGesture, { once: true })
    }

    // Re-run on every visibility change back to visible (catches PWA resume from background)
    const onVisible = () => { if (!document.hidden) setup() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      document.removeEventListener('click',      onGesture)
      document.removeEventListener('touchstart', onGesture)
    }
  }, [user?.id])

  // Listen for SW postMessage — handles notification clicks, call alerts, push events
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const handler = (e) => {
      const msg = e.data
      if (!msg?.type) return

      if (msg.type === 'OPEN_CHAT' && msg.contactId) {
        const cid = Number(msg.contactId) || msg.contactId
        setActiveId(cid)
        setMobileShowChat(true)
        if (msg.replyText) {
          setTimeout(() => {
            if (inputRef.current) { inputRef.current.value = msg.replyText; inputRef.current.focus() }
          }, 400)
        }
        return
      }

      if (msg.type === 'INCOMING_CALL_PUSH') {
        // Guard: only show call UI if this user is actually logged in.
        const currentAuthToken = localStorage.getItem('token')
        if (!currentAuthToken || currentAuthToken === 'null') return

        // Use refs (not stale closure state) to check if we're already in a call
        if (activeCallRef.current) return  // already in active call — ignore
        const fromId = parseInt(msg.from)
        // If banner already showing for this same caller — ignore duplicate push
        if (incomingCallRef.current && incomingCallRef.current.from === fromId) return

        // App is open (possibly backgrounded) — show in-app call UI + play ringtone
        const fromC = spvbContactsRef.current.find(c => c.id === fromId)
        const displayName = msg.callerName || fromC?.display_name || fromC?.username || `User ${fromId}`
        setIncomingCall({
          callType: msg.callType || 'voice',
          from: fromId,
          contact: {
            id: fromId, name: displayName,
            initials: displayName.slice(0, 2).toUpperCase(),
            color: AVATAR_COLORS[fromId % AVATAR_COLORS.length],
            avatar_url: fromC?.avatar_url || '',
          },
          sdp: null, // SDP arrives separately via WS once app is focused
        })
        _playRingtone()
        return
      }

      if (msg.type === 'ANSWER_CALL') {
        // User tapped Answer on the OS notification — app is now focused
        const fromId = parseInt(msg.from)
        const fromC = spvbContactsRef.current.find(c => c.id === fromId)
        const displayName = fromC?.display_name || fromC?.username || `User ${fromId}`
        setIncomingCall(prev => prev || {
          callType: msg.callType || 'voice', from: fromId,
          contact: { id: fromId, name: displayName, initials: displayName.slice(0, 2).toUpperCase(), color: AVATAR_COLORS[fromId % AVATAR_COLORS.length], avatar_url: fromC?.avatar_url || '' },
          sdp: null,
        })
        return
      }

      if (msg.type === 'DECLINE_CALL') {
        // User tapped Decline on the OS notification
        wsRef.current?.send(JSON.stringify({ type: 'call_reject', target: String(msg.from) }))
        setIncomingCall(null)
        _stopRingtone()
        return
      }

      if (msg.type === 'PUSH_MSG') {
        // Background push arrived while app is open — play notification sound
        _playNotifSound()
        return
      }

      if (msg.type === 'RESUBSCRIBE' && msg.subscription) {
        // Browser rotated push keys — re-register with server
        const token = localStorage.getItem('token')
        const sub = msg.subscription
        fetch(apiUrl('/api/push/subscribe'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(sub),
        }).catch(() => {})
        return
      }
    }
    navigator.serviceWorker.addEventListener('message', handler)
    return () => navigator.serviceWorker.removeEventListener('message', handler)
  }, []) // eslint-disable-line

  // Open chat or call from URL param (e.g. /?chat=123 or /?call=456 from push click)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const chatId      = params.get('chat')
    const callId      = params.get('call')
    const declineCall = params.get('decline_call')

    // App opened by SW to silently decline a call — send reject via WS then close
    if (declineCall && user?.id) {
      window.history.replaceState({}, '', '/')
      const fromId = String(parseInt(declineCall))
      // Wait for WS to be ready then send reject
      const sendReject = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'call_reject', target: fromId }))
        } else {
          setTimeout(sendReject, 300)
        }
      }
      setTimeout(sendReject, 500)
    }

    if (chatId && user?.id) {
      setActiveId(Number(chatId) || chatId)
      window.history.replaceState({}, '', '/')
    }
    if (callId && user?.id) {
      // App was opened by tapping a call notification — show incoming call UI
      const fromId = parseInt(callId)
      const fromC = spvbContactsRef.current.find(c => c.id === fromId)
      const displayName = fromC?.display_name || fromC?.username || `User ${fromId}`
      setIncomingCall(prev => prev || {
        callType: 'voice', from: fromId,
        contact: { id: fromId, name: displayName, initials: displayName.slice(0, 2).toUpperCase(), color: AVATAR_COLORS[fromId % AVATAR_COLORS.length], avatar_url: fromC?.avatar_url || '' },
        sdp: null,
      })
      window.history.replaceState({}, '', '/')
    }
  }, [user?.id])

  // Fetch a contact's public key — cached in memory ref + localStorage for fast cold starts
  const getContactPubKey = async (contactId) => {
    const cid = String(contactId)
    // 1. In-memory cache (fastest)
    if (contactPubKeysRef.current[cid]) return contactPubKeysRef.current[cid]
    // 2. localStorage cache (survives page reload)
    try {
      const cached = localStorage.getItem(`pubkey_${cid}`)
      if (cached) { contactPubKeysRef.current[cid] = cached; return cached }
    } catch {}
    // 3. Fetch from server — V1 ECDH key only
    try {
      const token = localStorage.getItem('token')
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000))
        const res = await fetch(apiUrl(`/api/users/${cid}/pubkey`), { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) break
        const { pubkey } = await res.json()
        if (pubkey) {
          contactPubKeysRef.current[cid] = pubkey
          try { localStorage.setItem(`pubkey_${cid}`, pubkey) } catch {}
          return pubkey
        }
      }
    } catch {}
    return null
  }

  // Fetch V2 RSA-OAEP public key for a contact (used for encrypting new messages)
  const getContactPubKeyV2 = async (contactId) => {
    const cid = String(contactId)
    const cacheKey = `pubkey_v2_${cid}`
    if (contactPubKeysRef.current[cacheKey]) return contactPubKeysRef.current[cacheKey]
    try {
      const cached = localStorage.getItem(cacheKey)
      if (cached) { contactPubKeysRef.current[cacheKey] = cached; return cached }
    } catch {}
    try {
      const token = localStorage.getItem('token')
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000))
        const res = await fetch(apiUrl(`/api/users/${cid}/pubkey_v2`), { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) break
        const { pubkey } = await res.json()
        if (pubkey) {
          contactPubKeysRef.current[cacheKey] = pubkey
          try { localStorage.setItem(cacheKey, pubkey) } catch {}
          return pubkey
        }
      }
    } catch {}
    return null
  }

  /* ── Dark mode + font CSS variables ── */
  useEffect(() => {
    const root = document.documentElement
    if (darkMode) {
      root.style.setProperty('--bg-app', '#111b21')
      root.style.setProperty('--bg-sidebar', '#111b21')
      root.style.setProperty('--bg-chat', '#0b141a')
      root.style.setProperty('--bg-bubble-sent', '#005c4b')
      root.style.setProperty('--bg-bubble-recv', '#202c33')
      root.style.setProperty('--bg-input', '#2a3942')
      root.style.setProperty('--bg-header', '#202c33')
      root.style.setProperty('--text-primary', '#e9edef')
      root.style.setProperty('--text-secondary', '#8696a0')
      root.style.setProperty('--border-color', 'rgba(134,150,160,0.1)')
      root.style.setProperty('--hover-color', '#2a3942')
      root.setAttribute('data-theme', 'dark')
    } else {
      root.style.setProperty('--bg-app', '#f0f2f5')
      root.style.setProperty('--bg-sidebar', '#ffffff')
      root.style.setProperty('--bg-chat', '#efeae2')
      root.style.setProperty('--bg-bubble-sent', '#d9fdd3')
      root.style.setProperty('--bg-bubble-recv', '#ffffff')
      root.style.setProperty('--bg-input', '#ffffff')
      root.style.setProperty('--bg-header', '#f0f2f5')
      root.style.setProperty('--text-primary', '#111b21')
      root.style.setProperty('--text-secondary', '#667781')
      root.style.setProperty('--border-color', 'rgba(0,0,0,0.1)')
      root.style.setProperty('--hover-color', '#f5f6f6')
      root.setAttribute('data-theme', 'light')
    }
    const fontFamily = APP_FONTS.find(f => f.id === appFont)?.family || APP_FONTS[0].family
    root.style.setProperty('--app-font', fontFamily)
    document.body.style.fontFamily = `var(--app-font)`
  }, [darkMode, appFont])

  /* ── Auth + heartbeat + load contacts ── */
  useEffect(() => {
    const token = localStorage.getItem('token')
    const doLogout = () => { if (onLogout) onLogout(); else navigate('/login') }
    if (!token || token === 'null' || token === 'undefined') { doLogout(); return }
    try {
      const u = localStorage.getItem('user')
      if (u && u !== 'null' && u !== 'undefined') {
        const parsed = JSON.parse(u)
        if (parsed && typeof parsed === 'object') setUser(parsed)
        else { doLogout(); return }
      } else { doLogout(); return }
    } catch (_) { doLogout(); return }

    // Register current account in spvb_accounts on every login/load so Add Account flow works
    saveCurrentAccount()

    // Refresh user profile from DB on startup (gets latest avatar_url, cover_url, display_name)
    fetch(apiUrl('/api/auth/me'), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(fresh => {
        if (!fresh) return
        setUser(prev => {
          const merged = { ...prev, ...fresh, id: fresh.id || fresh.user_id || prev?.id }
          localStorage.setItem('user', JSON.stringify(merged))
          return merged
        })
        // Re-register with fresh profile data (avatar may have updated)
        setTimeout(saveCurrentAccount, 0)
      })
      .catch(() => {})

    const beat = async () => {
      const statusVisible = localStorage.getItem('show_online_status') !== 'off'
      try {
        const r = await fetch(apiUrl('/api/users/me/status'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: statusVisible ? 'online' : 'hidden' }) })
        if (r.status === 401) { if (onLogout) onLogout(); else { localStorage.clear(); navigate('/login') } }
      } catch (_) {}
    }
    beat()
    heartbeatRef.current = setInterval(beat, 30000)

    // For Google users: silently refresh Gmail + Contacts tokens — no UI prompt
    if (isGoogleUser()) {
      silentlyRefreshGoogleTokens(GOOGLE_CLIENT_ID)
    }

    const loadContacts = async (silent = false) => {
      if (!silent) setContactsLoading(true)
      try {
        const res = await fetch(apiUrl('/api/contacts'), { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const contacts = await res.json()
          setSpvbContacts(contacts)
          localStorage.setItem('contacts_cache', JSON.stringify(contacts))
          const nicks = {}
          contacts.forEach(c => { if (c.nickname) nicks[c.id] = c.nickname })
          setNicknames(nicks)
        }
      } catch (_) {} finally { if (!silent) setContactsLoading(false) }
    }
    // Show cached contacts immediately so UI is instant, then refresh in background
    try {
      const cached = JSON.parse(localStorage.getItem('contacts_cache') || '[]')
      if (cached.length > 0) {
        setSpvbContacts(cached)
        const nicks = {}
        cached.forEach(c => { if (c.nickname) nicks[c.id] = c.nickname })
        setNicknames(nicks)
        loadContacts(true) // silent background refresh
      } else {
        loadContacts()
      }
    } catch { loadContacts() }

    // Pre-warm E2E pubkey cache for all contacts so decryption is instant when a chat opens
    const prewarmPubkeys = async () => {
      try {
        const contactsRes = await fetch(apiUrl('/api/contacts'), { headers: { Authorization: `Bearer ${token}` } })
        if (!contactsRes.ok) return
        const contacts = await contactsRes.json()
        // Fetch ALL pubkeys IN PARALLEL — no sequential loop
        await Promise.all(contacts.map(async c => {
          const cid = String(c.id)
          if (contactPubKeysRef.current[cid] || localStorage.getItem(`pubkey_${cid}`)) return
          try {
            const r = await fetch(apiUrl(`/api/users/${cid}/pubkey`), { headers: { Authorization: `Bearer ${token}` } })
            if (r.ok) {
              const { pubkey } = await r.json()
              if (pubkey) {
                contactPubKeysRef.current[cid] = pubkey
                try { localStorage.setItem(`pubkey_${cid}`, pubkey) } catch {}
              }
            }
          } catch {}
        }))
        // Once all keys are warm, immediately retry any still-encrypted messages
        const e2eKey = e2ePrivKeyRef.current
        if (e2eKey) decryptAllPending(e2eKey)
      } catch {}
    }
    // Run immediately — no delay — so keys are ready before decryptAllPending fires
    prewarmPubkeys()
    const contactsInterval = setInterval(() => loadContacts(true), 120000)

    const loadGroups = async () => {
      try {
        const res = await fetch(apiUrl('/api/groups'), { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) setGroups(await res.json())
      } catch {}
    }
    loadGroups()
    const groupsInterval = setInterval(loadGroups, 30000)

    const loadSavedContacts = async () => {
      try {
        const res = await fetch(apiUrl('/api/contacts/saved'), { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const { saved_contact_ids } = await res.json()
          setSavedContactIds(new Set(saved_contact_ids))
          localStorage.setItem('saved_contacts', JSON.stringify(saved_contact_ids))
        }
      } catch (_) {}
    }
    loadSavedContacts()

    const loadBlocked = async () => {
      try {
        const res = await fetch(apiUrl('/api/contacts/blocked'), { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const list = await res.json()
          setBlockedIds(new Set(list.map(u => u.id)))
        }
      } catch {}
    }
    loadBlocked()

    const recentCacheRef = { current: null }
    const fetchRecent = async () => {
      try {
        const res = await fetch(apiUrl('/api/messages/recent'), { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const data = await res.json()
          const mapped = {}
          const unreads = {}
          const readUpdates = {} // contact ids where all sent msgs are read
          for (const [cid, info] of Object.entries(data)) {
            const id = parseInt(cid)
            const ts = info.created_at?.endsWith('Z') ? info.created_at : info.created_at + 'Z'
            const d = new Date(ts)
            const now = new Date()
            let timeStr
            if (d.toDateString() === now.toDateString()) timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            else timeStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
            mapped[id] = { lastMsg: info.last_message, time: timeStr, fromMe: info.from_me }
            if (id !== activeIdRef.current) {
              unreads[id] = info.unread_count || 0
            }
            // Mark all sent messages as read if server confirms recipient read them
            if (info.all_sent_read) readUpdates[id] = true
          }
          const mappedJson = JSON.stringify(mapped)
          if (mappedJson !== recentCacheRef.current) {
            recentCacheRef.current = mappedJson
            setRecentConversations(prev => ({ ...prev, ...mapped }))
            setUnreadCounts(prev => ({ ...prev, ...unreads }))
          }
          // Update blue ticks for all threads where recipient has read everything
          if (Object.keys(readUpdates).length > 0) {
            setLiveMessages(prev => {
              const next = { ...prev }
              for (const contactId of Object.keys(readUpdates)) {
                const thread = prev[contactId]
                if (thread) {
                  next[contactId] = thread.map(m => m.sent ? { ...m, read: true } : m)
                }
              }
              return next
            })
          }
        }
      } catch (_) {}
    }
    fetchRecentRef.current = fetchRecent
    fetchRecent()
    const recentInterval = setInterval(fetchRecent, 20000)
    // Sync all message state — called on wake/online/reconnect
    const syncAll = () => {
      fetchRecent()
      fetchMsgsRef.current?.()
    }

    // Retry sync with backoff — network may not be ready the instant screen turns on
    let wakeRetryTimer = null
    const syncWithRetry = () => {
      clearTimeout(wakeRetryTimer)
      syncAll()
      // Retry once after 1.5s in case network wasn't up yet on first call
      wakeRetryTimer = setTimeout(syncAll, 1500)
      // And once more after 4s for slow mobile radio wake
      wakeRetryTimer = setTimeout(syncAll, 4000)
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        beat()
        pollOnline()
        syncWithRetry()
        // Show the most recent queued toast from while we were away
        if (pendingToastsRef.current.length > 0) {
          const latest = pendingToastsRef.current[pendingToastsRef.current.length - 1]
          pendingToastsRef.current = []
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
          setInAppToast(latest)
          toastTimerRef.current = setTimeout(() => setInAppToast(null), 5000)
        }
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    // When network comes back (offline → online transition)
    const onNetworkBack = () => syncWithRetry()
    window.addEventListener('online', onNetworkBack)

    // Mobile: 'focus' fires when app comes to foreground even if visibilitychange didn't
    const onFocus = () => { if (document.visibilityState === 'visible') syncWithRetry() }
    window.addEventListener('focus', onFocus)

    const pollOnline = async () => {
      try {
        const res = await fetch(apiUrl('/api/users/online'), { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const data = await res.json()
          // Record the exact moment we observed each user as online
          const now = new Date().toISOString()
          for (const [uid, info] of Object.entries(data)) {
            if (info.online_status === 'online') lastSeenRef.current[uid] = now
          }
          setOnlineMap(data)
        }
      } catch (_) {}
    }
    pollOnline()
    const onlineInterval = setInterval(pollOnline, 10000)

    const fetchStatuses = async () => {
      try {
        const res = await fetch(apiUrl('/api/statuses'), { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return
        const list = await res.json()
        const myId = JSON.parse(localStorage.getItem('user') || '{}').id
        const fmt = (iso) => {
          try {
            // Ensure UTC is parsed correctly (append Z if missing)
            const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z')
            const now = new Date()
            const diffMs = now - d
            const diffMin = Math.floor(diffMs / 60000)
            if (diffMin < 1) return 'just now'
            if (diffMin < 60) return `${diffMin} min ago`
            const diffHr = Math.floor(diffMin / 60)
            if (diffHr < 24 && d.toDateString() === now.toDateString())
              return `${diffHr} hr ago`
            if (diffHr < 48) return 'Yesterday'
            return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
          } catch { return '' }
        }
        // My own statuses — sort newest first so statusUpdates[0] is the latest
        const mine = list
          .filter(s => s.user_id === myId)
          .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))
          .map(s => ({
            id: s.id, text: s.content, type: s.type,
            color: s.color, videoUrl: s.video_url,
            time: fmt(s.created_at), created_at: s.created_at, isMe: true,
            view_count: s.view_count || 0,
            viewers: s.viewers || [],
            reactions: s.reactions || [],
          }))
        if (mine.length > 0) setStatusUpdates(mine)
        // Group other users' statuses by user_id — only show saved contacts
        const savedIds = new Set(JSON.parse(localStorage.getItem('saved_contacts') || '[]').map(String))
        const grouped = {}
        list.filter(s => s.user_id !== myId && savedIds.has(String(s.user_id))).forEach(s => {
          if (!grouped[s.user_id]) {
            grouped[s.user_id] = {
              userId: s.user_id,
              name: s.display_name || s.username || `User ${s.user_id}`,
              initials: (s.display_name || s.username || 'U').slice(0, 2).toUpperCase(),
              color: AVATAR_COLORS[s.user_id % AVATAR_COLORS.length],
              avatar_url: s.avatar_url || '',
              statuses: [],
            }
          }
          grouped[s.user_id].statuses.push({
            id: s.id, content: s.content, type: s.type,
            color: s.color, videoUrl: s.video_url,
            time: fmt(s.created_at), created_at: s.created_at,
          })
        })
        const contactStatusList = Object.values(grouped)
        setContactStatuses(contactStatusList)

        // If a user posted a NEW status after we marked them seen, clear their seen flag
        // so the new status shows as unread (compare latest status time vs seen timestamp)
        const seenData = (() => { try { return JSON.parse(localStorage.getItem('seen_status_times') || '{}') } catch { return {} } })()
        let changed = false
        for (const group of contactStatusList) {
          const uid = String(group.userId)
          const latestTime = group.statuses.reduce((max, s) => s.created_at > max ? s.created_at : max, '')
          if (seenData[uid] && latestTime > seenData[uid]) {
            // New status posted after we last viewed — remove from seen set
            setSeenStatusUsers(prev => {
              const next = new Set(prev)
              next.delete(uid)
              localStorage.setItem('seen_status_users', JSON.stringify([...next]))
              return next
            })
            delete seenData[uid]
            changed = true
          }
        }
        if (changed) localStorage.setItem('seen_status_times', JSON.stringify(seenData))
      } catch {}
    }
    fetchStatusesRef.current = fetchStatuses
    fetchStatuses()
    const statusInterval = setInterval(fetchStatuses, 30000)

    // Load per-contact ringtone preferences from server and sync with localStorage
    fetch(apiUrl('/api/contacts/ringtones'), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : {})
      .then(map => {
        if (map && typeof map === 'object') {
          const merged = { ...JSON.parse(localStorage.getItem('contact_ringtones') || '{}'), ...map }
          localStorage.setItem('contact_ringtones', JSON.stringify(merged))
          setContactRingtones(merged)
        }
      }).catch(() => {})

    const goOffline = () => fetch(apiUrl('/api/users/me/status'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: 'offline' }) }).catch(() => {})
    window.addEventListener('beforeunload', goOffline)

    // Auto-update: reload if a new version of the app is deployed (ETag on index.html changes)
    let _pageEtag = ''
    const checkAppVersion = async () => {
      try {
        const r = await fetch('/', { method: 'HEAD', cache: 'no-store' })
        const etag = r.headers.get('etag') || r.headers.get('last-modified') || ''
        if (!_pageEtag) { _pageEtag = etag; return }
        if (etag && etag !== _pageEtag) window.location.reload()
      } catch {}
    }
    checkAppVersion()
    const versionInterval = setInterval(checkAppVersion, 5 * 60 * 1000)  // check every 5 minutes

    // Keep Render/cloud backend alive — ping every 10 min to avoid cold-start spin-down
    const keepAlive = () => fetch(apiUrl('/api/ping')).catch(() => {})
    const keepAliveInterval = setInterval(keepAlive, 10 * 60 * 1000)

    return () => {
      clearInterval(heartbeatRef.current)
      clearInterval(onlineInterval)
      clearInterval(recentInterval)
      clearInterval(statusInterval)
      clearInterval(contactsInterval)
      clearInterval(versionInterval)
      clearInterval(keepAliveInterval)
      clearInterval(groupsInterval)
      clearTimeout(wakeRetryTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onNetworkBack)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('beforeunload', goOffline)
      goOffline()
    }
  }, [navigate])

  // Fetch call logs when calls tab opens or when a chat opens
  useEffect(() => { if (tab === 'calls' || activeId) fetchCallLogs() }, [tab, activeId]) // eslint-disable-line

  // Keep refs fresh
  useEffect(() => { spvbContactsRef.current = spvbContacts }, [spvbContacts])
  useEffect(() => {
    activeIdRef.current = activeId
    // Retry decrypting any locked messages whenever user opens a conversation
    if (activeId && e2eReadyRef.current) setTimeout(() => decryptAllPending(e2ePrivKeyRef.current), 100)
  }, [activeId])
  useEffect(() => { notifSoundRef.current = notifSound }, [notifSound])
  useEffect(() => { msgRingtoneRef.current = msgRingtone }, [msgRingtone])
  useEffect(() => { callRingtoneRef.current = callRingtone }, [callRingtone])

  // Update page title + PWA home-screen icon badge whenever unread count changes
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((s, v) => s + (v || 0), 0)
    document.title = total > 0 ? `(${total}) SPVB Chat` : 'SPVB Chat'
    try {
      if ('setAppBadge' in navigator) {
        if (total > 0) navigator.setAppBadge(total)
        else navigator.clearAppBadge()
      }
    } catch {}
  }, [unreadCounts])

  // Persist messages to localStorage so chat survives page refresh
  // Keep liveMessagesRef in sync so async callbacks can read current state
  useEffect(() => { liveMessagesRef.current = liveMessages }, [liveMessages])

  // Defensive reset: whenever activeCall clears (call ended any way), always
  // reset callMinimized so the next call never starts in PiP mode.
  useEffect(() => { if (!activeCall) setCallMinimized(false) }, [activeCall])

  useEffect(() => {
    if (!user?.id) return
    try {
      const retDays = user?.msg_retention_days ?? 1
      const cutoff = retDays > 0 ? Date.now() - retDays * 24 * 60 * 60 * 1000 : 0
      const trimmed = {}
      for (const [id, msgs] of Object.entries(liveMessages)) {
        trimmed[id] = (msgs || [])
          .filter(m => !m.created_at || cutoff === 0 || new Date(m.created_at).getTime() > cutoff)
          .slice(-150)
          .map(m => m.media_url?.startsWith('blob:') ? { ...m, media_url: null } : m)
      }
      localStorage.setItem(`msgs_${user.id}`, JSON.stringify(trimmed))
    } catch {}
  }, [liveMessages, user?.id])

  useEffect(() => {
    if (!user?.id) return
    try { localStorage.setItem(`recent_${user.id}`, JSON.stringify(recentConversations)) } catch {}
  }, [recentConversations, user?.id])

  // WebSocket connection for real-time signaling — auto-reconnects on drop
  useEffect(() => {
    const uid = user?.id
    if (!uid) return
    const token = localStorage.getItem('token')
    if (!token || token === 'null') return

    let destroyed = false
    let retryTimer = null

    const connect = () => {
      if (destroyed) return
      const ws = new WebSocket(wsUrl(`/ws/${uid}?token=${token}`))
      wsRef.current = ws

      ws.onopen = () => {
        if (destroyed) { ws.close(); return }
        const t = localStorage.getItem('token')
        fetch(apiUrl('/api/users/me/status'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ status: 'online' }) }).catch(() => {})
        // Re-sync missed messages after any WS reconnect
        fetchMsgsRef.current?.()
        fetchRecentRef.current?.()
      }
      ws.onmessage = (event) => { wsHandlerRef.current?.(event) }
      ws.onerror = () => {}
      ws.onclose = () => {
        wsRef.current = null
        if (!destroyed) retryTimer = setTimeout(connect, 800)
      }
    }

    connect()

    return () => {
      destroyed = true
      clearTimeout(retryTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [user?.id])

  /* ── Live message polling for active DM ── */
  const lastMsgIdRef = useRef({}) // contactId -> last confirmed server message id
  useEffect(() => {
    if (!activeId || activeId === 'bot' || (typeof activeId !== 'number' && activeId !== SELF_CHAT_ID) || !user?.id) {
      fetchMsgsRef.current = null
      return
    }
    const token = localStorage.getItem('token')
    const myId = user.id
    // For self-chat, use myId as the contact for the API call
    const contactId = activeId === SELF_CHAT_ID ? myId : activeId
    let initialDone = false

    const parseMsg = (m) => {
      const ts = m.created_at?.endsWith('Z') ? m.created_at : m.created_at + 'Z'
      return {
        id: m.id, text: m.content, // text may be encrypted; decrypted below
        _encrypted: String(m.content || '').startsWith('__e2e__|') || String(m.content || '').startsWith('__e2ev2__|'),
        _raw: m,  // keep original server message for V2 wrapped key access
        created_at: ts,
        media_url: m.media_url || null, media_type: m.media_type || null, fileName: m.file_name || null,
        replyTo: m.reply_to || null,
        sent: m.from_user_id === myId,
        time: new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        read: m.from_user_id === myId ? (m.is_read || false) : true,
        status: m.status || (m.is_read ? 'seen' : 'sent'),
        pending: false,
        from_user_id: m.from_user_id,
      }
    }

    // Decrypt any encrypted messages in a batch — waits for keys to be ready first
    const decryptBatch = async (msgs) => {
      await waitForE2eKey()
      const key = e2ePrivKeyRef.current
      if (!key) return msgs  // keys never loaded; return as-is (render guard covers display)
      // Always fetch fresh pubkey when opening a chat — ensures we use the current key
      // even if contact recently switched devices and uploaded a new public key
      const cid = String(contactId)
      delete contactPubKeysRef.current[cid]
      try { localStorage.removeItem(`pubkey_${cid}`) } catch {}
      const theirPub = await getContactPubKey(contactId)
      // If their pub key isn't available yet, return msgs as-is and schedule a full retry
      if (!theirPub) {
        setTimeout(() => decryptAllPending(key), 3000)
        return msgs
      }
      const v2Priv = v2PrivKeyRef.current
      const myId = user?.id
      return Promise.all(msgs.map(async (m) => {
        const txt = String(m.text || '')
        const needsDecrypt = m._encrypted || txt.startsWith('__e2e__|') || txt.startsWith('__e2ev2__|')
        if (!needsDecrypt) return m
        // V2: RSA-OAEP wrapped key
        if (v2Priv && isV2Message(m._raw || m)) {
          const raw = m._raw || m
          const isSender = raw.from_user_id === myId
          const wrappedKey = isSender ? raw.encrypted_key_for_sender : raw.encrypted_key_for_receiver
          if (!wrappedKey) return m
          const plain = await decryptMessageWithWrappedKey(m.text, wrappedKey, v2Priv)
          const stillCipher = String(plain || '').startsWith('__e2e')
          return { ...m, text: plain, _encrypted: stillCipher }
        }
        // V1: ECDH
        const plain = await decryptMessage(m.text, key, theirPub)
        const stillCipher = String(plain || '').startsWith('__e2e')
        return { ...m, text: plain, _encrypted: stillCipher }
      }))
    }

    // stateKey: where messages are stored in liveMessages (SELF_CHAT_ID for self, contactId otherwise)
    const stateKey = activeId === SELF_CHAT_ID ? SELF_CHAT_ID : contactId

    // Full load on first open — replaces list once, then never again
    const initialLoad = async () => {
      try {
        const res = await fetch(apiUrl(`/api/messages/conversation/${contactId}`), { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return
        const data = await res.json()
        const serverMsgs = await decryptBatch(data.map(parseMsg))
        const maxId = serverMsgs.reduce((acc, m) => Math.max(acc, m.id || 0), lastMsgIdRef.current[stateKey] || 0)
        lastMsgIdRef.current[stateKey] = maxId
        setLiveMessages(prev => {
          const existing = prev[stateKey] || []
          const existingById = new Map(existing.map(m => [m.id, m]))
          const merged = serverMsgs.map(sm => {
            const local = existingById.get(sm.id)
            if (!local) return sm
            const read = local.read || sm.read
            const mediaUrl = sm.media_url || local.media_url
            if (local.read === read && local.text === sm.text && local.media_url === mediaUrl && local._encrypted === sm._encrypted) return local
            return { ...local, read, text: sm.text, media_url: mediaUrl, _encrypted: sm._encrypted }
          })
          const serverIds = new Set(serverMsgs.map(m => m.id))
          const pendingMsgs = existing.filter(em => em.pending && !serverIds.has(em.id))
          const newList = [...merged, ...pendingMsgs]
          if (newList.length === existing.length && newList.every((m, i) => m === existing[i])) return prev
          return { ...prev, [stateKey]: newList }
        })
        initialDone = true
        // If any messages are still cipher (key wasn't ready yet), retry decryption
        // once the key becomes available. waitForE2eKey ensures we don't retry forever.
        const hasCipher = serverMsgs.some(m => m._encrypted)
        if (hasCipher) {
          waitForE2eKey().then(() => {
            const key = e2ePrivKeyRef.current
            if (key) setTimeout(() => decryptAllPending(key), 200)
          })
        } else if (e2ePrivKeyRef.current) {
          decryptAllPending(e2ePrivKeyRef.current)
        }
      } catch (_) {}
    }

    // Incremental poll — only fetches messages newer than lastMsgId, appends only
    const pollNewMsgs = async () => {
      if (!initialDone) return
      const sinceId = lastMsgIdRef.current[stateKey] || 0
      try {
        const res = await fetch(apiUrl(`/api/messages/conversation/${contactId}?since_id=${sinceId}`), { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) return
        const data = await res.json()
        if (!data.length) return
        const newMsgs = await decryptBatch(data.map(parseMsg))
        const maxId = newMsgs.reduce((acc, m) => Math.max(acc, m.id || 0), sinceId)
        lastMsgIdRef.current[stateKey] = maxId
        setLiveMessages(prev => {
          const existing = prev[stateKey] || []
          const existingIds = new Set(existing.map(m => m.id))
          const toAdd = newMsgs.filter(m => !existingIds.has(m.id))
          if (!toAdd.length) return prev
          const _now = Date.now()
          const withoutDups = existing.filter(em => {
            if (!em.pending) return true
            return !toAdd.some(nm => nm.from_user_id === em.from_user_id && nm.text === em.text && (_now - new Date(em.created_at).getTime()) < 10000)
          })
          return { ...prev, [stateKey]: [...withoutDups, ...toAdd] }
        })
      } catch (_) {}
    }

    const fetchMsgs = async () => { await initialLoad(); await pollNewMsgs() }
    fetchMsgsRef.current = fetchMsgs
    initialLoad().then(() => { initialDone = true })
    pollRef.current = setInterval(pollNewMsgs, 4000)
    return () => {
      clearInterval(pollRef.current)
      fetchMsgsRef.current = null
    }
  }, [activeId, user?.id])

  /* ── Group message polling ── */
  useEffect(() => {
    if (!activeId || typeof activeId !== 'string' || !activeId.startsWith('g_') || !user?.id) return
    const groupId = parseInt(activeId.slice(2))
    const token = localStorage.getItem('token')
    const myId = user.id
    const gKey = activeId
    const fetchGMsgs = async () => {
      try {
        const res = await fetch(apiUrl(`/api/groups/${groupId}/messages`), { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const data = await res.json()
          const normalized = data.map(m => ({
            ...m,
            text: m.content,
            sent: m.from_user_id === myId,
            time: (() => { try { const ts = m.created_at?.endsWith('Z') ? m.created_at : m.created_at + 'Z'; return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' } })()
          }))
          setGroupMessages(prev => {
            const existing = prev[gKey] || []
            const serverIds = new Set(normalized.map(m => m.id))
            const pendingMsgs = existing.filter(m => m.pending && !serverIds.has(m.id))
            const newList = [...normalized, ...pendingMsgs]
            if (newList.length === existing.length && newList.every((m, i) => m.id === existing[i]?.id)) return prev
            return { ...prev, [gKey]: newList }
          })
        }
      } catch {}
    }
    fetchGMsgs()
    const interval = setInterval(fetchGMsgs, 3000)
    return () => clearInterval(interval)
  }, [activeId, user?.id])

  /* ── Scroll to bottom — only when active conversation grows or tab switches ── */
  const _isGroupActive = typeof activeId === 'string' && activeId.startsWith('g_')
  const activeMsgCount = _isGroupActive ? (groupMessages[activeId] || []).length : (liveMessages[activeId] || []).length
  useEffect(() => { msgEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [activeMsgCount, botMsgs, activeId, botTyping])

  /* ── Gmail auto-fetch ── */
  const fetchEmails = useCallback(async (token) => {
    if (!token) return
    setMailLoading(true); setMailError('')
    try {
      const listRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=25&labelIds=INBOX', { headers: { Authorization: `Bearer ${token}` } })
      if (listRes.status === 401) {
        localStorage.removeItem('gmail_access_token'); localStorage.removeItem('gmail_token_expiry'); setGmailToken(null)
        setMailError(isGoogleUser() ? 'Gmail session expired. Please log out and sign in again.' : 'Gmail access expired. Please reconnect.')
        return
      }
      const listData = await listRes.json()
      if (!listData.messages?.length) { setMails([]); return }
      const details = await Promise.all(listData.messages.map((m) =>
        fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      ))
      setMails(details.map(parseEmailMeta).sort((a, b) => b.rawDate - a.rawDate))
    } catch { setMailError('Failed to load emails.') } finally { setMailLoading(false) }
  }, [])

  const connectGmail = useCallback(() => {
    // Google users: use stored token — never prompt
    if (isGoogleUser()) {
      const stored = localStorage.getItem('gmail_access_token')
      if (stored && isGmailTokenValid()) {
        setGmailToken(stored)
        fetchEmails(stored)
      } else {
        if (GOOGLE_CLIENT_ID && window.google?.accounts?.oauth2) {
          const tc = window.google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
            callback: (r) => {
              if (r.access_token) {
                storeGmailToken(r.access_token, r.expires_in)
                setGmailToken(r.access_token)
                fetchEmails(r.access_token)
              }
            },
            error_callback: () => setMailError('Unable to refresh Gmail access. Please log out and sign in again with Google.'),
          })
          tc.requestAccessToken({ prompt: 'none' })
        }
      }
      return
    }
    // Non-Google users: show OAuth prompt
    if (!GOOGLE_CLIENT_ID || !window.google?.accounts?.oauth2) { setMailError('Google client ID not configured.'); return }
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      callback: (resp) => {
        if (resp.access_token) {
          storeGmailToken(resp.access_token, resp.expires_in)
          setGmailToken(resp.access_token)
          fetchEmails(resp.access_token)
        } else { setMailError(resp.error_description || 'Gmail access denied.') }
      }
    })
    tc.requestAccessToken()
  }, [fetchEmails])

  useEffect(() => {
    if (tab !== 'mail') return
    // Google users: auto-connect to Gmail when tab opens — no prompt
    if (!gmailToken && isGoogleUser()) {
      const stored = localStorage.getItem('gmail_access_token')
      if (stored && isGmailTokenValid()) {
        setGmailToken(stored)
        return
      }
      connectGmail()
      return
    }
    if (gmailToken && mails.length === 0 && !mailLoading) fetchEmails(gmailToken)
  }, [tab, gmailToken, mails.length, mailLoading, fetchEmails, connectGmail])

  /* ── Computed contacts list ── */
  const allContacts = useMemo(() => {
    const spvb = spvbContacts.map((c) => {
      const saved = savedContactIds.has(c.id)
      const realName = c.display_name || c.username
      const nickname = nicknames[c.id] || ''
      const displayName = saved ? (nickname || realName) : 'Unknown'
      return {
        id: c.id,
        name: displayName,
        nickname,
        realName,
        initials: saved ? displayName.slice(0, 2).toUpperCase() : '?',
        color: saved ? AVATAR_COLORS[c.id % AVATAR_COLORS.length] : '#8696a0',
        about: saved ? c.about : undefined,
        email: saved ? c.email : undefined,
        phone: saved ? c.phone : undefined,
        cover_url: saved ? c.cover_url : '',
        online_status: saved ? c.online_status : undefined,
        last_seen: saved ? c.last_seen : undefined,
        avatar_url: saved ? c.avatar_url : '',
        isGroup: false, isSpvb: true, isSaved: saved,
        _realName: realName,
        lastMsg: (() => { const t = liveMessages[c.id]?.slice(-1)[0]?.text ?? recentConversations[c.id]?.lastMsg ?? 'Tap to start chatting'; return (String(t).startsWith('__e2e__|') || String(t).startsWith('e2e__|')) ? '' : t })(),
        time: liveMessages[c.id]?.slice(-1)[0]?.time ?? recentConversations[c.id]?.time ?? '',
        unread: unreadCounts[Number(c.id)] || unreadCounts[c.id] || 0,
      }
    })
    const spvbEmails = new Set(spvbContacts.map(c => c.email))
    const invites = googleContacts
      .filter(gc => gc.email && !spvbEmails.has(gc.email))
      .map(gc => ({
        id: `g_${gc.email}`, name: gc.name || gc.email.split('@')[0],
        initials: (gc.name || gc.email).slice(0, 2).toUpperCase(),
        color: '#8696a0', email: gc.email, isInvite: true, isGroup: false,
        lastMsg: 'Invite to SPVB', time: '', unread: 0, avatar_url: gc.photo || '',
      }))
    return [...spvb, ...invites]
  }, [spvbContacts, googleContacts, liveMessages, savedContactIds, recentConversations, unreadCounts, nicknames])

  const botContact = useMemo(() => {
    const last = botMsgs?.slice(-1)[0]
    return { ...BOT_CONTACT, lastMsg: last?.text ?? '👋 Say Hi!', time: last?.time ?? '', unread: 0 }
  }, [botMsgs])

  // Self-chat: pinned entry showing the user's own profile
  const selfContact = useMemo(() => {
    const myName = user?.display_name || user?.username || 'Me'
    const initials = myName.charAt(0).toUpperCase()
    const selfMsgs = liveMessages[SELF_CHAT_ID] || []
    const last = selfMsgs.slice(-1)[0]
    return {
      id: SELF_CHAT_ID,
      name: myName + ' (You)',
      initials,
      color: AVATAR_COLORS[(user?.id || 0) % AVATAR_COLORS.length],
      avatar_url: user?.avatar_url || '',
      lastMsg: last?.text ?? '📌 Tap to add notes',
      time: last?.time ?? '',
      unread: 0,
      isSelf: true,
      isGroup: false,
    }
  }, [user, liveMessages])

  // Group contacts for chat list
  const groupContacts = useMemo(() => groups.map(g => ({
    id: `g_${g.id}`,
    groupId: g.id,
    name: g.name,
    initials: g.name.slice(0, 2).toUpperCase(),
    color: AVATAR_COLORS[g.id % AVATAR_COLORS.length],
    avatar_url: g.avatar_url || '',
    isGroup: true,
    members: g.member_details || [],
    lastMsg: g.last_message || 'Tap to open group',
    time: g.last_message_time ? (() => { try { const ts = g.last_message_time.endsWith('Z') ? g.last_message_time : g.last_message_time + 'Z'; const d = new Date(ts); const now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) } catch { return '' } })() : '',
    unread: 0,
  })), [groups])

  const activeContact = [...allContacts, botContact, selfContact, ...groupContacts].find(c => c.id === activeId)
  const isGroupChat = typeof activeId === 'string' && activeId.startsWith('g_')
  const _retentionCutoff = (() => { const d = user?.msg_retention_days ?? 1; return d > 0 ? Date.now() - d * 86400000 : 0 })()
  const _filterByRetention = (msgs) => {
    const perChatHours = chatAutoDelete[String(activeId)]
    const perChatCutoff = perChatHours ? Date.now() - perChatHours * 3600000 : 0
    return msgs.filter(m => {
      if (!m.created_at) return true
      const ts = new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z').getTime()
      if (_retentionCutoff > 0 && ts < _retentionCutoff) return false
      if (perChatCutoff > 0 && ts < perChatCutoff) return false
      return true
    })
  }
  const _rawChatMsgs = activeId === 'bot' ? botMsgs : activeId === SELF_CHAT_ID ? (liveMessages[SELF_CHAT_ID] || []) : isGroupChat ? (groupMessages[activeId] || []) : _filterByRetention(liveMessages[activeId] || [])
  const chatMsgs = useMemo(() => {
    if (!activeId || activeId === 'bot' || activeId === SELF_CHAT_ID || isGroupChat) return _rawChatMsgs
    const contactCallLogs = callLogs.filter(l => String(l.contact_id) === String(activeId)).map(l => ({
      id: `call_${l.id}`,
      _isCallLog: true,
      call_type: l.call_type,
      direction: l.direction,
      status: l.status,
      duration: l.duration,
      created_at: l.created_at,
    }))
    if (!contactCallLogs.length) return _rawChatMsgs
    const merged = [..._rawChatMsgs, ...contactCallLogs].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z').getTime() : 0
      const tb = b.created_at ? new Date(b.created_at.endsWith('Z') ? b.created_at : b.created_at + 'Z').getTime() : 0
      return ta - tb
    })
    return merged
  }, [_rawChatMsgs, callLogs, activeId, isGroupChat])
  const pinnedChatIds = useMemo(() => { try { const uid = user?.id; return new Set(JSON.parse(localStorage.getItem(`pinnedChats_${uid}`) || '[]')) } catch { return new Set() } }, [chatPins, user?.id])
  const filteredContacts = allContacts.filter(c => {
    if (showArchivedList) return archivedChats.has(String(c.id))
    if (c.isInvite) return true
    if (blockedIds.has(c.id)) return false
    if (c.isSpvb && !c.isSaved && !liveMessages[c.id]?.length && !recentConversations[c.id]) return false
    if (archivedChats.has(String(c.id))) return false
    return true
  }).filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.email || '').toLowerCase().includes(search.toLowerCase()) ||
    (c._realName?.toLowerCase().includes(search.toLowerCase()))
  ).sort((a, b) => {
    const ap = pinnedChatIds.has(String(a.id)) ? 1 : 0
    const bp = pinnedChatIds.has(String(b.id)) ? 1 : 0
    return bp - ap
  })

  const getContactStatus = (c) => {
    if (!c) return { label: '', isOnline: false }
    if (c.id === 'bot') return { label: botTyping ? 'typing...' : 'SPVB AI • always online', isOnline: true }
    if (c.id === SELF_CHAT_ID) return { label: 'Your personal notes', isOnline: true }
    if (c.isGroup) return { label: `${c.members?.length || 0} members`, isOnline: true }
    if (c.isInvite) return { label: c.email, isOnline: false }
    // Only show online presence to saved contacts (privacy: unsaved users see nothing)
    if (!c.isSaved) return { label: '', isOnline: false }
    const live = onlineMap[String(c.id)]
    const status = live?.online_status || c.online_status
    if (status === 'hidden') return { label: '', isOnline: false } // user hid their status
    if (status === 'online') return { label: 'online', isOnline: true }
    // Use the locally-observed last-online time (accurate to last poll) over the stale DB timestamp
    const localLastSeen = lastSeenRef.current[String(c.id)]
    const lastSeen = localLastSeen || live?.updated_at || c.last_seen
    if (lastSeen) {
      try {
        const d = new Date(lastSeen.endsWith('Z') ? lastSeen : lastSeen + 'Z')
        const now = new Date()
        const diffMs = now - d
        let lsStr
        if (diffMs < 60000) lsStr = 'just now'
        else if (d.toDateString() === now.toDateString()) lsStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        else lsStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        return { label: `last seen ${lsStr}`, isOnline: false }
      } catch {}
    }
    return { label: 'offline', isOnline: false }
  }

  const userInitial = (user?.display_name || user?.username || 'U')[0].toUpperCase()

  const markRead = async (contactId) => {
    const numId = Number(contactId)
    if (!numId || isNaN(numId)) return
    // Clear by both key forms so string/number mismatch never leaves a stale count
    setUnreadCounts(prev => {
      const next = { ...prev }
      next[numId] = 0
      next[String(numId)] = 0
      return next
    })
    setLiveMessages(prev => ({
      ...prev,
      [numId]: (prev[numId] || []).map(m => m.sent ? m : { ...m, read: true }),
    }))
    const token = localStorage.getItem('token')
    try {
      await fetch(apiUrl(`/api/messages/read/${numId}`), { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })
    } catch {}
  }

  const selectChat = (id) => {
    // Always allow navigation — lock overlay handles access restriction
    setLockOverlayPinDigits([])
    setActiveId(id); setShowEmoji(false); setMobileShowChat(true); setShowContactInfo(false); setReplyTo(null); setShowAttachMenu(false); setMsgMenuId(null)
    if (typeof id === 'number' && lockedChats.has(String(id)) && !chatUnlocked.has(String(id))) return // Don't mark read or focus input yet
    markRead(id)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const initiateCall = (contact, type) => {
    if (!contact || contact.id === 'bot' || contact.isInvite) return
    // Check if contact is currently online — don't ring if they're offline
    const status = getContactStatus(contact)
    if (!status.isOnline) {
      setCallOfflineContact({ contact, type })
      return
    }
    setActiveCall({ type, contact, role: 'caller' })
  }

  const fetchCallLogs = async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(apiUrl('/api/call-logs'), { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setCallLogs(await res.json())
    } catch {}
  }

  const saveCallLog = async (logData) => {
    const token = localStorage.getItem('token')
    try {
      await fetch(apiUrl('/api/call-logs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(logData),
      })
      fetchCallLogs()
    } catch {}
  }

  const syncPhoneContacts = async () => {
    setSyncMsg('')
    if (!('contacts' in navigator) || !('ContactsManager' in window)) {
      setSyncMsg('Contact sync requires Chrome on Android or Safari on iOS.')
      return
    }
    setSyncingContacts(true)
    try {
      const contacts = await navigator.contacts.select(['name', 'tel'], { multiple: true })
      const phones = contacts.flatMap(c => c.tel || [])
      if (!phones.length) { setSyncingContacts(false); return }
      const token = localStorage.getItem('token')
      const res = await fetch(apiUrl('/api/contacts/sync-phones'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ phones }),
      })
      if (res.ok) {
        const matched = await res.json()
        if (matched.length > 0) {
          setSpvbContacts(prev => {
            const existingIds = new Set(prev.map(c => c.id))
            const newOnes = matched.filter(c => !existingIds.has(c.id)).map(c => ({
              ...c, isSpvb: true,
              name: c.display_name || c.username,
              initials: (c.display_name || c.username || '?').slice(0, 2).toUpperCase(),
              color: AVATAR_COLORS[c.id % AVATAR_COLORS.length],
            }))
            return [...prev, ...newOnes]
          })
          setSyncMsg(`Found ${matched.length} SPVB user${matched.length > 1 ? 's' : ''} in your contacts!`)
        } else {
          setSyncMsg('No new SPVB users found in your phone contacts.')
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') setSyncMsg('Contact sync failed.')
    }
    setSyncingContacts(false)
  }

  const _dismissCallNotification = (fromId) => {
    // Use .ready so this works even if the SW controller hasn't claimed the page yet
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.ready.then(reg => {
      reg.active?.postMessage({ type: 'DISMISS_CALL_NOTIFICATION', from: String(fromId) })
    }).catch(() => {})
  }

  const acceptCall = () => {
    if (!incomingCall) return
    _stopRingtone()
    _dismissCallNotification(incomingCall.from)
    const buffered = pendingIceCandidatesRef.current
    pendingIceCandidatesRef.current = []
    setActiveCall({ type: incomingCall.callType, contact: incomingCall.contact, role: 'callee', offerSdp: incomingCall.sdp, initialCandidates: buffered })
    setIncomingCall(null)
  }

  const declineCall = () => {
    if (!incomingCall) return
    _stopRingtone()
    _dismissCallNotification(incomingCall.from)
    wsRef.current?.send(JSON.stringify({ type: 'call_reject', target: String(incomingCall.from) }))
    saveCallLog({ contact_id: incomingCall.from, call_type: incomingCall.callType || 'voice', direction: 'incoming', status: 'rejected', duration: 0 })
    setIncomingCall(null)
  }

  const handleContactSaved = async (contactId) => {
    setSavedContactIds(prev => {
      const next = new Set(prev)
      next.add(contactId)
      localStorage.setItem('saved_contacts', JSON.stringify([...next]))
      return next
    })
    // Re-fetch contacts so the newly saved person appears in the list immediately
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(apiUrl('/api/contacts'), { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setSpvbContacts(await res.json())
    } catch {}
  }

  // Keep botMsgsRef in sync so fetchSmartReplies always sees latest messages
  useEffect(() => { botMsgsRef.current = botMsgs }, [botMsgs])

  const fetchSmartReplies = useCallback(async (newBotText) => {
    // Show static replies instantly — no loading wait
    const staticReplies = getBotQuickReplies(newBotText || '')
    setBotQuickReplies(staticReplies)
    const token = localStorage.getItem('token')
    // Build context: previous messages + new bot reply appended
    const prevMsgs = botMsgsRef.current.slice(-8).map(m => ({ role: m.sent ? 'user' : 'bot', text: m.text || '' }))
    if (newBotText) prevMsgs.push({ role: 'bot', text: newBotText })
    try {
      const res = await fetch(apiUrl('/api/smart-reply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: prevMsgs }),
      })
      if (res.ok) {
        const { suggestions } = await res.json()
        // Replace static chips with smart ones only if API returned something different
        if (Array.isArray(suggestions) && suggestions.length > 0) {
          setBotQuickReplies(suggestions)
        }
      }
    } catch {}
    // No loading state — static chips already showing
    setSmartRepliesLoading(false)
  }, [])

  // Shared helper: encrypt plaintext for a recipient.
  // Uses V2 (RSA-OAEP hybrid) when both parties have RSA master keys.
  // Falls back to V1 (ECDH) for contacts who haven't upgraded yet.
  const encryptForRecipient = async (plaintext, recipientId) => {
    await waitForE2eKey()

    // ── V2 path: RSA-OAEP hybrid encryption ──────────────────────────────
    const myV2Priv = v2PrivKeyRef.current
    const myV2Pub  = v2PubKeyRef.current
    if (myV2Priv && myV2Pub) {
      // Use V2 RSA pubkey for sending — NOT the V1 ECDH pubkey
      const theirPubJwk = LOCAL_MODE
        ? await localGetPubKey(recipientId)
        : await getContactPubKeyV2(recipientId)
      if (theirPubJwk) {
        const theirRsaPub = await importRsaPublicKey(theirPubJwk)
        if (theirRsaPub) {
          try {
            const result = await encryptMessageForTwo(plaintext, myV2Pub, theirRsaPub)
            return { ...result, encrypted: true }
          } catch (err) {
            console.warn('[E2Ev2] encryptMessageForTwo failed:', err?.message)
          }
        }
      }
    }

    // ── V1 fallback: ECDH shared key (legacy) ────────────────────────────
    const key = e2ePrivKeyRef.current
    if (!key) return { content: plaintext, encrypted: false }
    const theirPub = await getContactPubKey(recipientId)
    if (!theirPub) return { content: plaintext, encrypted: false }
    try {
      const content = await encryptMessage(plaintext, key, theirPub)
      return { content, encrypted: true }
    } catch {
      return { content: plaintext, encrypted: false }
    }
  }

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || !activeId) return
    setInput(''); setShowEmoji(false)

    // Group chat
    if (typeof activeId === 'string' && activeId.startsWith('g_')) {
      const gId = parseInt(activeId.slice(2))
      await sendGroupMessage(gId, text)
      return
    }

    if (activeId === 'bot') {
      const msg = { id: nextBotId(), text, sent: true, time: nowTime(), read: true, replyTo: replyTo ? { ...replyTo } : null }
      setBotMsgs(prev => [...prev, msg])
      setReplyTo(null)
      setBotTyping(true)
      setBotQuickReplies([])
      setTimeout(() => {
        const reply = getBotReply(text)
        setBotMsgs(prev => [...prev, { id: nextBotId(), text: reply, sent: false, time: nowTime(), read: true }])
        setBotTyping(false)
        fetchSmartReplies(reply)
      }, 600 + Math.random() * 900)
      return
    }

    // Self-chat (Notes to self)
    if (activeId === SELF_CHAT_ID) {
      const myId = user?.id
      if (!myId) return
      const token = localStorage.getItem('token')
      const replySnap = replyTo ? { ...replyTo } : null
      setReplyTo(null)
      const localId = Date.now()
      const optimistic = { id: localId, text, created_at: new Date().toISOString(), sent: true, time: nowTime(), read: true, pending: true, from_user_id: myId, replyTo: replySnap }
      setLiveMessages(prev => ({ ...prev, [SELF_CHAT_ID]: [...(prev[SELF_CHAT_ID] || []), optimistic] }))
      try {
        const room = `dm_${myId}_${myId}`
        const res = await fetch(apiUrl('/api/messages'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content: text, room, recipient_id: myId, encrypted: false }) })
        if (res.ok) {
          const serverMsg = await res.json()
          setLiveMessages(prev => ({
            ...prev,
            [SELF_CHAT_ID]: (prev[SELF_CHAT_ID] || []).map(m =>
              m.id === localId ? { ...m, id: serverMsg.id, pending: false } : m
            )
          }))
        }
      } catch (_) {}
      return
    }

    if (typeof activeId !== 'number') return
    const token = localStorage.getItem('token')
    const myId = user?.id
    const room = `dm_${Math.min(myId, activeId)}_${Math.max(myId, activeId)}`
    const replySnap = replyTo ? { ...replyTo } : null
    setReplyTo(null)
    const localId = Date.now()
    // Show plain text locally, send encrypted to server
    const optimistic = { id: localId, text, created_at: new Date().toISOString(), sent: true, time: nowTime(), read: false, pending: true, from_user_id: myId, replyTo: replySnap, _raw: { from_user_id: myId } }
    setLiveMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), optimistic] }))
    setRecentConversations(prev => ({ ...prev, [activeId]: { lastMsg: text, time: nowTime(), fromMe: true } }))
    try {
      const encResult = await encryptForRecipient(text, activeId)
      const { content: encryptedContent, encrypted: isEncrypted,
              encrypted_key_for_sender, encrypted_key_for_receiver } = encResult
      const preview = text.slice(0, 60)
      const msgBody = {
        content: encryptedContent,
        room,
        recipient_id: activeId,
        reply_to: replySnap,
        encrypted: isEncrypted,
        preview,
        ...(encrypted_key_for_sender   && { encrypted_key_for_sender }),
        ...(encrypted_key_for_receiver && { encrypted_key_for_receiver }),
      }

      if (LOCAL_MODE) {
        // Store locally — no server call
        const saved = await localSaveMessage({ ...msgBody, from_user_id: myId, sender: user?.username || '', created_at: new Date().toISOString() })
        setLiveMessages(prev => ({
          ...prev,
          [activeId]: (prev[activeId] || []).map(m =>
            m.id === localId ? { ...m, id: saved.id, pending: false } : m
          )
        }))
      } else {
        const res = await fetch(apiUrl('/api/messages'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(msgBody) })
        if (res.ok) {
          const serverMsg = await res.json()
          // Attach encrypted key fields to _raw so decryption can find them
          const rawWithKeys = {
            ...serverMsg,
            encrypted_key_for_sender,
            encrypted_key_for_receiver,
            from_user_id: myId,
          }
          setLiveMessages(prev => ({
            ...prev,
            [activeId]: (prev[activeId] || []).map(m =>
              m.id === localId
                ? { ...m, id: serverMsg.id, pending: false,
                    _raw: rawWithKeys,
                    _encrypted: isEncrypted,
                    time: new Date((serverMsg.created_at?.endsWith('Z') ? serverMsg.created_at : serverMsg.created_at + 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
                : m
            )
          }))
        }
      }
    } catch (_) {}
  }, [input, activeId, user?.id, replyTo, fetchSmartReplies])

  const handleKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }

  const FILE_LIMITS = { image: 10, video: 50, audio: 16, document: 25 }
  // Silently compress images before upload — user sees nothing, just faster sends.
  // Max 1280px on longest side, JPEG quality 82%. GIFs pass through unchanged.
  const _compressImage = (file) => new Promise((resolve) => {
    if (!file.type.startsWith('image/') || file.type === 'image/gif') { resolve(file); return }
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const MAX = 1280
      let { width: w, height: h } = img
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX }
        else       { w = Math.round(w * MAX / h); h = MAX }
      }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      // Force .jpg extension — backend detects type by extension, not MIME
      const safeName = file.name.replace(/\.[^.]+$/, '') + '.jpg'
      canvas.toBlob(blob => {
        if (!blob) { resolve(file); return }
        // Mark as already compressed so sendMedia() skips re-compression
        const out = Object.assign(new File([blob], safeName, { type: 'image/jpeg' }), { _spvbCropped: true })
        resolve(out)
      }, 'image/jpeg', 0.82)
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })

  const sendMedia = useCallback(async (file) => {
    if (!file || typeof activeId !== 'number') return
    const token = localStorage.getItem('token')
    const myId = user?.id
    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')
    const isAudio = file.type.startsWith('audio/')
    const mediaType = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'document'
    const limitMB = FILE_LIMITS[mediaType]
    if (file.size > limitMB * 1024 * 1024) {
      alert(`File too large. Maximum size for ${mediaType}s is ${limitMB} MB.`)
      return
    }
    // Compress images silently before upload — skip if already compressed by crop
    if (isImage && !file._spvbCropped) file = await _compressImage(file)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('recipient_id', String(activeId))
    const objectUrl = URL.createObjectURL(file)
    const replySnap = replyTo ? { ...replyTo } : null
    setReplyTo(null)
    const optimistic = {
      id: Date.now(), text: '',
      created_at: new Date().toISOString(),
      media_url: objectUrl, media_type: mediaType, fileName: file.name,
      replyTo: replySnap, _viewOnce: viewOnceMode,
      sent: true, time: nowTime(), read: false, pending: true, from_user_id: myId,
    }
    if (viewOnceMode) setViewOnceMode(false) // reset after use
    setLiveMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), optimistic] }))
    try {
      const res = await fetch(apiUrl('/api/messages/media'), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData,
      })
      if (res.ok) {
        const serverMsg = await res.json()
        setLiveMessages(prev => ({
          ...prev,
          [activeId]: (prev[activeId] || []).map(m =>
            m.id === optimistic.id
              ? { ...serverMsg, text: serverMsg.content, media_url: serverMsg.media_url, media_type: serverMsg.media_type, fileName: serverMsg.file_name, replyTo: replySnap, sent: true, time: nowTime(), read: false, pending: false, from_user_id: myId }
              : m
          ),
        }))
      }
    } catch {}
  }, [activeId, user?.id, replyTo])

  const sendBotMedia = useCallback((file) => {
    const objectUrl = URL.createObjectURL(file)
    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')
    const mediaType = isImage ? 'image' : isVideo ? 'video' : 'document'
    const userMsg = {
      id: nextBotId(), text: '', media_url: objectUrl, media_type: mediaType,
      fileName: file.name, sent: true, time: nowTime(), read: true,
      replyTo: replyTo ? { ...replyTo } : null,
    }
    setBotMsgs(prev => [...prev, userMsg])
    setReplyTo(null)
    setBotTyping(true)
    setBotQuickReplies([])
    const docReplies = ["📄 Got the document! I can't open files, but thanks for sharing 😊", "File received! 📎 I'm a chatbot so I can't read it, but I see it!"]
    const imgReplies = ["📷 Nice photo! I can see you've shared an image 😊", "Beautiful! 🖼️ Thanks for sharing that!", "📸 Lovely picture!"]
    const vidReplies = ["🎬 Cool video! Thanks for sharing 🎥", "Video received! 📹 Looks great!"]
    const pool = mediaType === 'document' ? docReplies : mediaType === 'image' ? imgReplies : vidReplies
    const replyText = pool[Math.floor(Math.random() * pool.length)]
    setTimeout(() => {
      setBotMsgs(prev => [...prev, { id: nextBotId(), text: replyText, sent: false, time: nowTime(), read: true }])
      setBotTyping(false)
      fetchSmartReplies(replyText)
    }, 600 + Math.random() * 900)
  }, [replyTo, fetchSmartReplies])

  const formatRecTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`

  const startRecording = useCallback(async () => {
    setShowAttachMenu(false)
    setShowEmoji(false)
    if (!navigator.mediaDevices?.getUserMedia) {
      docInputRef.current.accept = 'audio/*'
      docInputRef.current?.click()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        }
      })
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find(t => MediaRecorder.isTypeSupported(t)) || ''
      const mr = new MediaRecorder(stream, {
        ...(mimeType && { mimeType }),
        audioBitsPerSecond: 128000,
      })
      audioChunksRef.current = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.start(200)
      mediaRecorderRef.current = mr
      setIsRecording(true)
      setRecordingSeconds(0)
      recordingTimerRef.current = setInterval(() => setRecordingSeconds(s => s + 1), 1000)
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert('🎤 Microphone access denied.\n\nPlease allow microphone access in your browser settings, then try again.')
      } else if (err.name === 'NotFoundError') {
        alert('🎤 No microphone found. Please connect a microphone and try again.')
      } else {
        docInputRef.current?.click()
      }
    }
  }, [])

  const stopAndSendRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr) return
    clearInterval(recordingTimerRef.current)
    setIsRecording(false)
    setRecordingSeconds(0)
    mr.onstop = () => {
      const recMimeType = mr.mimeType || 'audio/webm'
      const ext = recMimeType.includes('mp4') ? 'mp4' : recMimeType.includes('ogg') ? 'ogg' : 'webm'
      const blob = new Blob(audioChunksRef.current, { type: recMimeType })
      const url = URL.createObjectURL(blob)
      const voiceFileName = `voice-message.${ext}`
      const currentId = activeIdRef.current
      if (currentId === 'bot') {
        const userMsg = { id: botMsgIdRef.current + 1, text: '', media_url: url, media_type: 'audio', fileName: voiceFileName, sent: true, time: nowTime(), read: true, replyTo: null }
        botMsgIdRef.current += 1
        setBotMsgs(prev => [...prev, userMsg])
        setBotTyping(true)
        setBotQuickReplies([])
        setTimeout(() => {
          botMsgIdRef.current += 1
          const voiceReply = "🎤 Voice message received! I'm a bot so I can't listen, but thanks for sending! 😊"
          setBotMsgs(prev => [...prev, { id: botMsgIdRef.current, text: voiceReply, sent: false, time: nowTime(), read: true }])
          setBotTyping(false)
          fetchSmartReplies(voiceReply)
        }, 900)
      } else if (typeof currentId === 'string' && currentId.startsWith('g_')) {
        // Voice note in group chat (#1)
        const gId = parseInt(currentId.slice(2))
        const file = new File([blob], voiceFileName, { type: recMimeType })
        const token = localStorage.getItem('token')
        const myId = JSON.parse(localStorage.getItem('user') || '{}')?.id
        const formData = new FormData()
        formData.append('file', file)
        formData.append('group_id', String(gId))
        const optimistic = { id: Date.now(), group_id: gId, from_user_id: myId, content: '', text: '', media_url: url, media_type: 'audio', fileName: voiceFileName, sender_name: '', created_at: new Date().toISOString(), sent: true, time: nowTime(), pending: true }
        setGroupMessages(prev => ({ ...prev, [currentId]: [...(prev[currentId] || []), optimistic] }))
        fetch(apiUrl(`/api/groups/${gId}/media`), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
          .then(r => r.ok ? r.json() : null)
          .then(serverMsg => {
            if (!serverMsg) return
            setGroupMessages(prev => ({
              ...prev,
              [currentId]: (prev[currentId] || []).map(m => m.id === optimistic.id ? { ...serverMsg, text: serverMsg.content || '', media_url: serverMsg.media_url, media_type: 'audio', sent: true, time: nowTime(), pending: false } : m)
            }))
          }).catch(() => {})
      } else if (typeof currentId === 'number') {
        const file = new File([blob], voiceFileName, { type: recMimeType })
        const token = localStorage.getItem('token')
        const myId = JSON.parse(localStorage.getItem('user') || '{}')?.id
        const formData = new FormData()
        formData.append('file', file)
        formData.append('recipient_id', String(currentId))
        const optimistic = { id: Date.now(), text: '', created_at: new Date().toISOString(), media_url: url, media_type: 'audio', fileName: voiceFileName, sent: true, time: nowTime(), read: false, pending: true, from_user_id: myId }
        setLiveMessages(prev => ({ ...prev, [currentId]: [...(prev[currentId] || []), optimistic] }))
        fetch(apiUrl('/api/messages/media'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
          .then(r => r.ok ? r.json() : null)
          .then(serverMsg => {
            if (!serverMsg) return
            setLiveMessages(prev => ({
              ...prev,
              [currentId]: (prev[currentId] || []).map(m =>
                m.id === optimistic.id ? { ...serverMsg, text: serverMsg.content || '', media_url: serverMsg.media_url || null, media_type: 'audio', fileName: serverMsg.file_name || voiceFileName, sent: true, time: nowTime(), read: false, pending: false, from_user_id: myId } : m
              )
            }))
          }).catch(() => {})
      }
      mr.stream.getTracks().forEach(t => t.stop())
    }
    mr.stop()
  }, [fetchSmartReplies])

  const cancelRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr) return
    clearInterval(recordingTimerRef.current)
    setIsRecording(false)
    setRecordingSeconds(0)
    mr.ondataavailable = null
    mr.onstop = null
    try { mr.stop() } catch {}
    mr.stream?.getTracks().forEach(t => t.stop())
  }, [])

  /* ── Pinned Chats helpers (#2) ── */
  const togglePinChat = (cid) => {
    const uid = user?.id; if (!uid) return
    const key = `pinnedChats_${uid}`
    const current = (() => { try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')) } catch { return new Set() } })()
    const sid = String(cid)
    if (current.has(sid)) current.delete(sid); else { if (current.size >= 3) { alert('You can pin up to 3 chats.'); return }; current.add(sid) }
    const arr = [...current]
    localStorage.setItem(key, JSON.stringify(arr))
    setChatPins(prev => { const n = { ...prev }; if (current.has(sid)) n[sid] = true; else delete n[sid]; return n })
  }

  /* ── Archived Chats helpers (#3) ── */
  const toggleArchiveChat = (cid) => {
    const uid = user?.id; if (!uid) return
    setArchivedChats(prev => {
      const n = new Set(prev); const sid = String(cid); if (n.has(sid)) n.delete(sid); else n.add(sid)
      try { localStorage.setItem(`archivedChats_${uid}`, JSON.stringify([...n])) } catch {}
      return n
    })
    if (String(activeId) === String(cid)) { setActiveId(null); setMobileShowChat(false) }
  }

  /* ── Starred Messages helpers (#4) ── */
  const toggleStarMsg = (msgId) => {
    const uid = user?.id; if (!uid) return
    setStarredMsgIds(prev => {
      const n = new Set(prev); const sid = String(msgId); if (n.has(sid)) n.delete(sid); else n.add(sid)
      try { localStorage.setItem(`starredMsgs_${uid}`, JSON.stringify([...n])) } catch {}
      return n
    })
  }

  /* ── Chat Labels helpers (#10) ── */
  const setChatLabel = (cid, labelId) => {
    const uid = user?.id; if (!uid) return
    setChatLabels(prev => {
      const n = { ...prev }; const sid = String(cid)
      if (!labelId || n[sid] === labelId) delete n[sid]; else n[sid] = labelId
      try { localStorage.setItem(`chatLabels_${uid}`, JSON.stringify(n)) } catch {}
      return n
    })
  }

  /* ── Broadcast (#9) ── */
  const sendBroadcast = async () => {
    if (!broadcastMsg.trim() || broadcastRecipients.length === 0) return
    setBroadcastSending(true)
    const token = localStorage.getItem('token'); const myId = user?.id
    for (const cid of broadcastRecipients) {
      if (typeof cid !== 'number') continue
      try {
        const room = `dm_${Math.min(myId, cid)}_${Math.max(myId, cid)}`
        const { content: enc, encrypted: isEnc } = await encryptForRecipient(broadcastMsg, cid)
        await fetch(apiUrl('/api/messages'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content: enc, room, recipient_id: cid, encrypted: isEnc }) })
      } catch {}
    }
    setBroadcastSending(false)
    setShowBroadcastModal(false)
    setBroadcastRecipients([])
    setBroadcastMsg('')
    alert(`Broadcast sent to ${broadcastRecipients.length} contact(s)!`)
  }

  /* ── Message Scheduling (#13) ── */
  const scheduleMessage = () => {
    const text = input.trim(); if (!text || !scheduleTime) return
    const sendAt = new Date(scheduleTime).getTime()
    const now = Date.now()
    if (sendAt <= now) { alert('Please select a future time.'); return }
    const delay = sendAt - now
    const sid = setTimeout(() => {
      sendMessage()
    }, delay)
    scheduledTimersRef.current.push(sid)
    setShowScheduler(false)
    setScheduleTime('')
    const d = new Date(scheduleTime); alert(`Message scheduled for ${d.toLocaleString()}`)
  }

  /* ── Polls (#7) ── */
  const sendPoll = async () => {
    if (!pollQuestion.trim() || pollOptions.filter(o => o.trim()).length < 2) return
    const gId = isGroupChat ? parseInt(activeId.slice(2)) : null
    if (!gId) return
    const token = localStorage.getItem('token')
    const opts = pollOptions.filter(o => o.trim())
    const pollContent = `__poll__|${pollQuestion}|${opts.join('||')}`
    try {
      await fetch(apiUrl(`/api/groups/${gId}/messages`), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content: pollContent }) })
    } catch {}
    setShowPollModal(false)
    setPollQuestion('')
    setPollOptions(['', ''])
  }

  /* ── Chat Wallpaper (#14) ── */
  const setChatWallpaper = (cid, wallpaperId) => {
    const uid = user?.id; if (!uid) return
    setChatWallpapers(prev => {
      const n = { ...prev }; if (!wallpaperId || wallpaperId === 'none') delete n[String(cid)]; else n[String(cid)] = wallpaperId
      try { localStorage.setItem(`chatWallpapers_${uid}`, JSON.stringify(n)) } catch {}
      return n
    })
  }

  /* ── Per-chat Disappearing Messages (#15) ── */
  const setChatAutoDeleteTimer = (cid, hours) => {
    const uid = user?.id; if (!uid) return
    setChatAutoDelete(prev => {
      const n = { ...prev }; if (!hours) delete n[String(cid)]; else n[String(cid)] = hours
      try { localStorage.setItem(`chatAutoDelete_${uid}`, JSON.stringify(n)) } catch {}
      return n
    })
  }

  /* ── Multiple Accounts (#16) ── */
  const _getRemovedAccountIds = () => { try { return new Set(JSON.parse(localStorage.getItem('spvb_removed_accounts') || '[]')) } catch { return new Set() } }
  const _setRemovedAccountIds = (set) => { try { localStorage.setItem('spvb_removed_accounts', JSON.stringify([...set])) } catch {} }

  // Synchronous save — does NOT rely on React state flush before reload
  const saveCurrentAccount = () => {
    const currentToken = localStorage.getItem('token')
    const userData = localStorage.getItem('user')
    if (!currentToken || !userData) return
    try {
      const u = JSON.parse(userData)
      if (!u?.id) return
      // Skip re-adding if user explicitly removed this account from the switcher
      const removed = _getRemovedAccountIds()
      if (removed.has(String(u.id))) return
      const existing = JSON.parse(localStorage.getItem('spvb_accounts') || '[]')
      // Use String comparison to avoid number/string type mismatch
      const filtered = existing.filter(a => String(a.id) !== String(u.id) && !removed.has(String(a.id)))
      const updated = [...filtered, { id: u.id, email: u.email, display_name: u.display_name, username: u.username, avatar_url: u.avatar_url, token: currentToken }]
      localStorage.setItem('spvb_accounts', JSON.stringify(updated))
      setSavedAccounts(updated)
    } catch {}
  }

  const removeAccount = (accId) => {
    const removed = _getRemovedAccountIds()
    removed.add(String(accId))
    _setRemovedAccountIds(removed)
    const updated = savedAccounts.filter(a => String(a.id) !== String(accId))
    setSavedAccounts(updated)
    try { localStorage.setItem('spvb_accounts', JSON.stringify(updated)) } catch {}
  }

  const switchAccount = (acc) => {
    // When explicitly switching to an account, un-block it so it gets tracked again
    const removed = _getRemovedAccountIds()
    removed.delete(String(acc.id))
    _setRemovedAccountIds(removed)
    // 1. Save current account to the list (synchronous)
    saveCurrentAccount()
    // 2. Swap credentials in localStorage
    localStorage.setItem('token', acc.token)
    localStorage.setItem('user', JSON.stringify({ id: acc.id, email: acc.email, display_name: acc.display_name, username: acc.username, avatar_url: acc.avatar_url }))
    // 3. Hard navigate — avoids React Router infinite redirect loop that occurs
    //    when onLogin() sets token then navigate('/login') triggers <Navigate to="/dashboard">
    window.location.href = '/dashboard'
  }

  const addNewAccount = () => {
    // Save current before clearing auth so we can return to it
    saveCurrentAccount()
    const accounts = localStorage.getItem('spvb_accounts')
    // Clear only auth, preserve account list
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    if (accounts) localStorage.setItem('spvb_accounts', accounts)
    setShowAccountSwitcher(false)
    if (onLogin) onLogin()  // sync App state: token removed from localStorage, sets App token to null
    navigate('/login')
  }

  const sendSpecialMsg = useCallback(async (content) => {
    const replySnap = replyTo ? { ...replyTo } : null
    setReplyTo(null)
    if (activeId === 'bot') {
      setBotMsgs(prev => [...prev, { id: nextBotId(), text: content, sent: true, time: nowTime(), read: true, replyTo: replySnap }])
    } else if (typeof activeId === 'number') {
      const token = localStorage.getItem('token')
      const myId = user?.id
      const room = `dm_${Math.min(myId, activeId)}_${Math.max(myId, activeId)}`
      const optimistic = { id: Date.now(), text: content, created_at: new Date().toISOString(), sent: true, time: nowTime(), read: false, pending: true, from_user_id: myId, replyTo: replySnap }
      setLiveMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), optimistic] }))
      try {
        const { content: enc, encrypted: isEnc } = await encryptForRecipient(content, activeId)
        const res = await fetch(apiUrl('/api/messages'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content: enc, room, recipient_id: activeId, reply_to: replySnap, encrypted: isEnc }) })
        if (res.ok) {
          const s = await res.json()
          setLiveMessages(prev => ({ ...prev, [activeId]: (prev[activeId] || []).map(m => m.id === optimistic.id ? { ...m, id: s.id, pending: false } : m) }))
        }
      } catch {}
    }
  }, [activeId, user?.id, replyTo])

  const shareLocation = useCallback(() => {
    setShowAttachMenu(false)
    if (!navigator.geolocation) { alert('Geolocation not supported by this browser.'); return }
    setLocationLoading(true)
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords
      let name = `${lat.toFixed(5)}, ${lng.toFixed(5)}`
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`)
        if (r.ok) { const d = await r.json(); name = d.display_name?.split(',').slice(0, 3).join(', ') || name }
      } catch {}
      setLocationLoading(false)
      const content = `__location__|${lat}|${lng}|${name}`
      sendSpecialMsg(content)
      if (activeId === 'bot') {
        setBotTyping(true); setBotQuickReplies([])
        setTimeout(() => {
          const locReply = '📍 Got your location! Thanks for sharing where you are 😊'
          setBotMsgs(prev => [...prev, { id: nextBotId(), text: locReply, sent: false, time: nowTime(), read: true }])
          setBotTyping(false); fetchSmartReplies(locReply)
        }, 900 + Math.random() * 600)
      }
    }, () => { setLocationLoading(false); alert('Could not get location. Please allow location access.') }, { timeout: 10000 })
  }, [activeId, sendSpecialMsg, fetchSmartReplies])

  const shareContact = useCallback((contact) => {
    setShowContactPicker(false)
    const content = `__contact__|${contact.name}|${contact.phone || ''}|${contact.email || ''}`
    sendSpecialMsg(content)
    if (activeId === 'bot') {
      setBotTyping(true); setBotQuickReplies([])
      setTimeout(() => {
        const ctReply = `👤 Got ${contact.name}'s info! Thanks for sharing 😊`
        setBotMsgs(prev => [...prev, { id: nextBotId(), text: ctReply, sent: false, time: nowTime(), read: true }])
        setBotTyping(false); fetchSmartReplies(ctReply)
      }, 700 + Math.random() * 500)
    }
  }, [activeId, sendSpecialMsg, fetchSmartReplies])

  const forwardMessage = useCallback(async (msg, contact) => {
    setShowForwardPicker(false)
    setForwardMsg(null)
    // Track forward count (#17)
    setForwardCounts(prev => ({ ...prev, [String(msg.id)]: (prev[String(msg.id)] || 0) + 1 }))
    const token = localStorage.getItem('token')
    const myId = user?.id
    if (!myId || !contact?.id) return
    const tid = Number(contact.id)
    if (!tid) return
    const room = `dm_${Math.min(myId, tid)}_${Math.max(myId, tid)}`
    const sp = parseSpecialContent(msg.text)
    if (msg.media_url && msg.media_type && !msg.media_url.startsWith('blob:')) {
      const optimistic = { id: Date.now(), text: '', created_at: new Date().toISOString(), media_url: msg.media_url, media_type: msg.media_type, fileName: msg.fileName, sent: true, time: nowTime(), read: false, pending: true, from_user_id: myId }
      setLiveMessages(prev => ({ ...prev, [tid]: [...(prev[tid] || []), optimistic] }))
      try {
        const r = await fetch(msg.media_url)
        const blob = await r.blob()
        let file = new File([blob], msg.fileName || 'media', { type: blob.type })
        if (file.type.startsWith('image/')) file = await _compressImage(file)
        const fd = new FormData()
        fd.append('file', file)
        fd.append('recipient_id', String(tid))
        const res = await fetch(apiUrl('/api/messages/media'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
        if (res.ok) {
          const s = await res.json()
          setLiveMessages(prev => ({ ...prev, [tid]: (prev[tid] || []).map(m => m.id === optimistic.id ? { ...s, text: s.content || '', media_url: s.media_url, media_type: s.media_type, fileName: s.file_name, sent: true, time: nowTime(), read: false, pending: false, from_user_id: myId } : m) }))
        }
      } catch {}
    } else {
      const content = sp ? msg.text : (msg.text || '')
      if (!content) return
      const optimistic = { id: Date.now(), text: content, created_at: new Date().toISOString(), sent: true, time: nowTime(), read: false, pending: true, from_user_id: myId }
      setLiveMessages(prev => ({ ...prev, [tid]: [...(prev[tid] || []), optimistic] }))
      setRecentConversations(prev => ({ ...prev, [tid]: { lastMsg: content, time: nowTime(), fromMe: true } }))
      try {
        const { content: enc, encrypted: isEnc } = await encryptForRecipient(content, tid)
        const res = await fetch(apiUrl('/api/messages'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content: enc, room, recipient_id: tid, encrypted: isEnc }) })
        if (res.ok) {
          const s = await res.json()
          setLiveMessages(prev => ({ ...prev, [tid]: (prev[tid] || []).map(m => m.id === optimistic.id ? { ...m, id: s.id, pending: false } : m) }))
        }
      } catch {}
    }
  }, [user?.id])

  const sendStatusMessageToChat = useCallback(async (targetUserId, text) => {
    const token = localStorage.getItem('token')
    const myId = user?.id
    if (!myId || !targetUserId) return
    const tid = Number(targetUserId)
    if (!tid) return
    const room = `dm_${Math.min(myId, tid)}_${Math.max(myId, tid)}`
    const optimistic = { id: Date.now(), text, created_at: new Date().toISOString(), sent: true, time: nowTime(), read: false, pending: true, from_user_id: myId }
    setLiveMessages(prev => ({ ...prev, [tid]: [...(prev[tid] || []), optimistic] }))
    setRecentConversations(prev => ({ ...prev, [tid]: { lastMsg: text, time: nowTime(), fromMe: true } }))
    try {
      const { content: enc, encrypted: isEnc } = await encryptForRecipient(text, tid)
      const res = await fetch(apiUrl('/api/messages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: enc, room, recipient_id: tid, encrypted: isEnc }),
      })
      if (res.ok) {
        const serverMsg = await res.json()
        setLiveMessages(prev => ({
          ...prev,
          [tid]: (prev[tid] || []).map(m =>
            m.pending && m.from_user_id === myId && m.text === text
              ? { ...m, id: serverMsg.id, pending: false, time: new Date((serverMsg.created_at?.endsWith('Z') ? serverMsg.created_at : serverMsg.created_at + 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
              : m
          )
        }))
      }
    } catch {}
  }, [user?.id])

  const logout = () => {
    setChatUnlocked(new Set())

    const authToken  = localStorage.getItem('token')
    const fcmToken   = localStorage.getItem('fcm_token')
    const sessionId  = localStorage.getItem('session_id')

    // ── 1. Close WebSocket immediately (backend marks user offline)
    try { wsRef.current?.close() } catch {}

    // ── 2. Notify backend: remove FCM token + session (fire-and-forget)
    if (authToken && fcmToken) {
      fetch(apiUrl('/api/push/fcm-token'), {
        method: 'DELETE', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ token: fcmToken }),
      }).catch(() => {})
    } else if (authToken) {
      fetch(apiUrl('/api/auth/logout'), {
        method: 'POST', keepalive: true,
        headers: { Authorization: `Bearer ${authToken}` },
      }).catch(() => {})
    }

    // ── 3. Unsubscribe from browser push (stops ALL push, even if backend token persists)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        // Unsubscribe VAPID push subscription
        reg.pushManager.getSubscription().then(sub => { if (sub) sub.unsubscribe() }).catch(() => {})

        // Clear SW caches (removes the 537 cached entries)
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).catch(() => {})

        // Clear the JWT stored in SW auth cache (used for inline reply)
        caches.open('spvb-auth-v1').then(c => c.delete('/sw-token')).catch(() => {})

        // Tell the SW to clear its in-memory unread counters
        reg.active?.postMessage({ type: 'LOGOUT_CLEAR' })
      }).catch(() => {})
    }

    // ── 4. Unregister Firebase messaging (stops foreground FCM delivery)
    try {
      import('../firebase.js').then(({ messaging }) => {
        if (messaging) {
          import('firebase/messaging').then(({ deleteToken }) => {
            deleteToken(messaging).catch(() => {})
          }).catch(() => {})
        }
      }).catch(() => {})
    } catch {}

    // ── 5. Clear all cookies for this domain
    try {
      document.cookie.split(';').forEach(c => {
        document.cookie = c.trim().split('=')[0] + '=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/'
      })
    } catch {}

    // ── 6. Clear Firebase IndexedDB databases (FCM tokens, installations)
    //    NEVER delete spvb_e2e — it holds the user's private key and must survive logout
    try {
      const FIREBASE_DBS = ['firebase-installations-database', 'firebase-messaging-database', 'firebaseLocalStorageDb', 'firebase-heartbeat-database']
      indexedDB.databases?.().then(dbs => {
        dbs.forEach(db => {
          if (db.name && (FIREBASE_DBS.includes(db.name) || db.name.startsWith('fbase_key'))) {
            indexedDB.deleteDatabase(db.name)
          }
        })
      }).catch(() => {})
    } catch {}

    // ── 7. Preserve multi-account data, clear everything else
    const preserve = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k === 'spvb_accounts' || k === 'spvb_removed_accounts' || k?.startsWith('e2e_ready_')) preserve[k] = localStorage.getItem(k)
    }
    localStorage.clear()
    sessionStorage.clear()
    Object.entries(preserve).forEach(([k, v]) => localStorage.setItem(k, v))

    if (onLogout) { onLogout(); return }
    navigate('/login')
  }

  /* ── Google Contacts sync ── */
  const syncGoogleContacts = useCallback(async () => {
    // For Google users: use stored access token silently — never prompt
    if (isGoogleUser()) {
      const storedToken = localStorage.getItem('gmail_access_token')
      if (storedToken && isGmailTokenValid()) {
        try {
          const contacts = await syncContactsWithToken(storedToken)
          setGoogleContacts(contacts)
        } catch (_) {}
      }
      return
    }
    // Non-Google users: show OAuth prompt as before
    if (!GOOGLE_CLIENT_ID || !window.google?.accounts?.oauth2) return
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/contacts.readonly',
      callback: async (resp) => {
        if (!resp.access_token) return
        try {
          const contacts = await syncContactsWithToken(resp.access_token)
          setGoogleContacts(contacts)
        } catch (_) {}
      }
    })
    tc.requestAccessToken()
  }, [])

  const saveContact = async (contactId) => {
    const token = localStorage.getItem('token')
    try {
      await fetch(apiUrl(`/api/contacts/${contactId}/save`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      setSavedContactIds(prev => {
        const next = new Set(prev)
        next.add(contactId)
        localStorage.setItem('saved_contacts', JSON.stringify([...next]))
        return next
      })
    } catch (_) {}
  }

  const unsaveContact = async (contactId) => {
    const token = localStorage.getItem('token')
    try {
      await fetch(apiUrl(`/api/contacts/${contactId}/save`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      setSavedContactIds(prev => {
        const next = new Set(prev)
        next.delete(contactId)
        localStorage.setItem('saved_contacts', JSON.stringify([...next]))
        return next
      })
    } catch (_) {}
  }

  const inviteContact = (contact) => {
    const msg = `Hey! I'm using SPVB — a secure messaging app. Join me at http://localhost:1403`
    const mailtoLink = `mailto:${contact.email}?subject=Join me on SPVB&body=${encodeURIComponent(msg)}`
    window.open(mailtoLink)
  }

  /* ── Gmail functions ── */
  const openMail = async (mail) => {
    setSelectedMail({ ...mail, body: null }); setMailBodyLoading(true)
    const token = localStorage.getItem('gmail_access_token')
    if (!token) { setMailBodyLoading(false); return }
    try {
      const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${mail.id}?format=full`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      setSelectedMail(prev => prev ? { ...prev, body: extractBody(data.payload) } : prev)
    } catch {} finally { setMailBodyLoading(false) }
  }

  /* ── Profile save ── */
  const openAccountSettings = () => {
    setEditName(user?.display_name || user?.username || '')
    setEditAbout(user?.about || 'Hey there! I am using SPVB.')
    setEditPhone(user?.phone || '')
    setEditRetention(user?.msg_retention_days ?? 3)
    setSettingsPage('account')
  }

  const _putAuthMe = async (body) => {
    const token = localStorage.getItem('token')
    const doFetch = () => fetch(apiUrl('/api/auth/me'), { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    let res
    try { res = await doFetch() } catch {
      // retry once after 800ms in case backend briefly reloaded
      await new Promise(r => setTimeout(r, 800))
      res = await doFetch()
    }
    return res
  }

  const saveProfile = async (extraFields = {}, closeSettings = true) => {
    setEditSaving(true)
    if (closeSettings) setEditSaveMsg(null)
    try {
      const body = { ...extraFields }
      if (closeSettings) {
        const name = editName.trim()
        if (!name) {
          setEditSaveMsg({ ok: false, text: 'Display name cannot be empty.' })
          setEditSaving(false)
          return
        }
        body.display_name = name
        body.about = editAbout ?? ''
        body.phone = editPhone ?? ''
        body.msg_retention_days = editRetention
      }
      const res = await _putAuthMe(body)
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        const updated = { ...user, ...data.user }
        setUser(updated)
        localStorage.setItem('user', JSON.stringify(updated))
        // Soft refresh: purge expired messages from memory using the new retention value
        const newRetDays = updated.msg_retention_days ?? 1
        const newCutoff = newRetDays > 0 ? Date.now() - newRetDays * 86400000 : 0
        if (newCutoff > 0) {
          setLiveMessages(prev => {
            const next = {}
            for (const [id, msgs] of Object.entries(prev)) {
              next[id] = (msgs || []).filter(m => !m.created_at || new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z').getTime() > newCutoff)
            }
            return next
          })
        }
        if (closeSettings) {
          setEditSaveMsg({ ok: true, text: 'Changes saved!' })
          setTimeout(() => { setEditSaveMsg(null); setSettingsPage(null) }, 1200)
        }
      } else {
        const errText = typeof data.detail === 'string' ? data.detail : `Save failed (${res.status}). Try again.`
        if (closeSettings) setEditSaveMsg({ ok: false, text: errText })
      }
    } catch (err) {
      if (closeSettings) setEditSaveMsg({ ok: false, text: `Network error: ${err?.message || 'Please try again.'}` })
    } finally { setEditSaving(false) }
  }

  const uploadCover = async (file) => {
    const token = localStorage.getItem('token')
    const formData = new FormData()
    formData.append('file', file)
    // Pass current cover URL so backend can delete the old Cloudinary asset
    const currentCoverUrl = user?.cover_url || ''
    if (currentCoverUrl) formData.append('old_url', currentCoverUrl)
    setCoverUploading(true)
    try {
      const res = await fetch(apiUrl('/api/upload?type=cover'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
      if (res.ok) {
        const { url } = await res.json()
        await saveProfile({ cover_url: url }, false)
      }
    } catch {} finally { setCoverUploading(false) }
  }

  const uploadAvatar = async (file) => {
    const token = localStorage.getItem('token')
    const formData = new FormData()
    formData.append('file', file)
    // Pass current avatar URL so backend can delete the old Cloudinary asset
    const currentAvatarUrl = user?.avatar_url || ''
    if (currentAvatarUrl) formData.append('old_url', currentAvatarUrl)
    setAvatarUploading(true)
    try {
      const res = await fetch(apiUrl('/api/upload?type=avatar'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
      if (res.ok) {
        const { url } = await res.json()
        await saveProfile({ avatar_url: url }, false)
        setSpvbContacts(prev => prev.map(c => c.id === user?.id ? { ...c, avatar_url: url } : c))
        // Update localStorage immediately so other parts of UI reflect the new avatar
        const stored = JSON.parse(localStorage.getItem('user') || '{}')
        localStorage.setItem('user', JSON.stringify({ ...stored, avatar_url: url }))
      }
    } catch {} finally { setAvatarUploading(false) }
  }

  const blockContact = async (contactId) => {
    const token = localStorage.getItem('token')
    setBlockedIds(prev => new Set([...prev, contactId]))
    try { await fetch(apiUrl(`/api/contacts/${contactId}/block`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } }) } catch {}
    setActiveId(null); setMobileShowChat(false)
  }

  const unblockContact = async (contactId) => {
    const token = localStorage.getItem('token')
    setBlockedIds(prev => { const n = new Set(prev); n.delete(contactId); return n })
    try { await fetch(apiUrl(`/api/contacts/${contactId}/block`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }) } catch {}
  }

  const saveNickname = async (contactId, nick) => {
    const token = localStorage.getItem('token')
    setNicknames(prev => ({ ...prev, [contactId]: nick }))
    try {
      await fetch(apiUrl(`/api/contacts/${contactId}/nickname`), { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ nickname: nick }) })
    } catch {}
    setEditingNickname(null)
  }

  const saveContactRingtone = async (contactId, ringtoneId) => {
    setContactRingtoneLocal(contactId, ringtoneId)
    setContactRingtones(prev => {
      const next = { ...prev }
      if (ringtoneId === 'default') delete next[String(contactId)]
      else next[String(contactId)] = ringtoneId
      return next
    })
    const token = localStorage.getItem('token')
    try {
      await fetch(apiUrl(`/api/contacts/${contactId}/ringtone`), { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ringtone: ringtoneId }) })
    } catch {}
  }

  // Per-chat theme helpers
  const getChatTheme = (id) => chatThemes[String(id)] || {}
  const saveChatTheme = (id, theme) => {
    const next = { ...chatThemes, [String(id)]: theme }
    setChatThemes(next)
    try { localStorage.setItem(`chatThemes_${user?.id}`, JSON.stringify(next)) } catch {}
  }

  // PIN hashing (simple non-crypto hash — fine for local lock)
  const hashPin = (pin) => {
    let h = 5381
    for (const c of pin) { h = ((h << 5) + h) + c.charCodeAt(0); h |= 0 }
    return String(h >>> 0)
  }

  const openLockModal = (contactId, mode) => {
    setLockTarget(contactId)
    setLockModalMode(mode)
    setLockPinInput('')
    setLockError('')
    setShowLockModal(true)
    setShowHeaderMenu(false)
  }

  const confirmLockAction = () => {
    const cid = String(lockTarget)
    const pin = lockPinInput.trim()
    if (lockModalMode === 'set') {
      if (pin.length < 4) { setLockError('PIN must be at least 4 digits'); return }
      const hashed = hashPin(pin)
      const newPins = { ...chatPins, [cid]: hashed }
      setChatPins(newPins)
      try { localStorage.setItem(`chatPins_${user?.id}`, JSON.stringify(newPins)) } catch {}
      const newLocked = new Set([...lockedChats, cid])
      setLockedChats(newLocked)
      try { localStorage.setItem(`lockedChats_${user?.id}`, JSON.stringify([...newLocked])) } catch {}
      setShowLockModal(false)
    } else if (lockModalMode === 'unlock') {
      if (chatPins[cid] && hashPin(pin) !== chatPins[cid]) { setLockError('Wrong PIN'); return }
      setChatUnlocked(prev => new Set([...prev, cid]))
      setShowLockModal(false)
      setActiveId(lockTarget)
      setShowEmoji(false); setMobileShowChat(true); setShowContactInfo(false); setReplyTo(null); setShowAttachMenu(false)
      markRead(lockTarget)
      setTimeout(() => inputRef.current?.focus(), 50)
    } else if (lockModalMode === 'remove') {
      if (chatPins[cid] && hashPin(pin) !== chatPins[cid]) { setLockError('Wrong PIN'); return }
      const newPins = { ...chatPins }; delete newPins[cid]
      setChatPins(newPins)
      try { localStorage.setItem(`chatPins_${user?.id}`, JSON.stringify(newPins)) } catch {}
      const newLocked = new Set(lockedChats); newLocked.delete(cid)
      setLockedChats(newLocked)
      try { localStorage.setItem(`lockedChats_${user?.id}`, JSON.stringify([...newLocked])) } catch {}
      setChatUnlocked(prev => { const n = new Set(prev); n.delete(cid); return n })
      setShowLockModal(false)
    }
  }

  // ── Modern lock overlay ──────────────────────────────────

  // Computed: is the currently-active chat locked?
  const isChatLocked = activeId != null && typeof activeId === 'number' &&
    lockedChats.has(String(activeId)) && !chatUnlocked.has(String(activeId))

  // Check biometric availability — show button only if registered AND supported
  useEffect(() => {
    if (window.PublicKeyCredential) {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()
        .then(ok => setBiometricAvail(ok && hasBiometricRegistered()))
        .catch(() => setBiometricAvail(false))
    }
  }, [])

  // Auto-lock chat when switching away from a locked-but-unlocked chat
  const prevActiveIdRef = useRef(null)
  useEffect(() => {
    const prev = prevActiveIdRef.current
    if (prev != null && typeof prev === 'number' && lockedChats.has(String(prev))) {
      setChatUnlocked(s => { const n = new Set(s); n.delete(String(prev)); return n })
    }
    prevActiveIdRef.current = activeId
  }, [activeId]) // eslint-disable-line

  const handleLockPinDigit = (digit) => {
    setLockOverlayPinDigits(prev => {
      const next = [...prev, digit]
      if (next.length === 4) {
        const cid = String(activeId)
        if (chatPins[cid] && hashPin(next.join('')) !== chatPins[cid]) {
          setLockOverlayShake(true)
          setTimeout(() => { setLockOverlayShake(false); setLockOverlayPinDigits([]) }, 600)
          return []
        }
        setChatUnlocked(s => new Set([...s, cid]))
        return []
      }
      return next
    })
  }

  const handleBiometric = async () => {
    if (!hasBiometricRegistered()) return // no credential — PIN handles it
    try {
      await authenticateBiometric()
      const cid = String(activeId)
      setChatUnlocked(s => new Set([...s, cid]))
    } catch (err) {
      if (err.code === 'LOCKED_OUT') {
        // Show lockout in UI — do nothing, PIN is still available
      }
      // USER_CANCELLED or AUTH_FAILED — let PIN handle it
    }
  }

  // ── QR Device Linking ────────────────────────────────────

  const generateQrCode = async () => {
    const token = localStorage.getItem('token')
    setQrStatus('generating')
    try {
      const res = await fetch(apiUrl('/api/devices/qr/generate'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setQrToken(data.token)
      // Generate QR code data URL using qrcode library
      try {
        const QRCode = (await import('qrcode')).default
        const qrContent = `${window.location.origin}/link-device?token=${data.token}`
        const dataUrl = await QRCode.toDataURL(qrContent, { width: 240, margin: 2, color: { dark: '#000', light: '#fff' } })
        setQrDataUrl(dataUrl)
        setQrStatus('ready')
        // Auto-expire after 10 minutes (matches backend TTL)
        setTimeout(() => setQrStatus(s => s === 'ready' || s === 'scanned' ? 'expired' : s), 10 * 60 * 1000)
      } catch {
        setQrStatus('idle')
      }
    } catch {
      setQrStatus('idle')
    }
  }

  const fetchLinkedDevices = async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(apiUrl('/api/sessions'), { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setLinkedDevices(await res.json())
    } catch {}
  }

  useEffect(() => { if (settingsPage === 'devices') fetchLinkedDevices() }, [settingsPage]) // eslint-disable-line
  // Stop any preview audio when navigating away from notifications settings
  useEffect(() => {
    if (settingsPage !== 'notifications') {
      if (previewAudioRef.current) { try { previewAudioRef.current.pause(); previewAudioRef.current.currentTime = 0 } catch {}; previewAudioRef.current = null }
    }
  }, [settingsPage])

  const removeLinkedDevice = async (sessionId) => {
    const token = localStorage.getItem('token')
    try {
      await fetch(apiUrl(`/api/sessions/${sessionId}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      setLinkedDevices(prev => prev.filter(d => d.id !== sessionId))
    } catch {}
  }

  const approveQrLink = async (token) => {
    const authToken = localStorage.getItem('token')
    try {
      await fetch(apiUrl(`/api/devices/qr/${token}/approve`), { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } })
      setQrLinkRequest(null)
    } catch {}
  }

  const rejectQrLink = async (token) => {
    const authToken = localStorage.getItem('token')
    try {
      await fetch(apiUrl(`/api/devices/qr/${token}/reject`), { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } })
      setQrLinkRequest(null)
    } catch {}
  }

  // ── QR scanner helpers (mobile scans desktop QR to approve login) ────────────
  const stopQrScanner = () => {
    if (qrScanRafRef.current) { cancelAnimationFrame(qrScanRafRef.current); qrScanRafRef.current = null }
    if (qrStreamRef.current) { qrStreamRef.current.getTracks().forEach(t => t.stop()); qrStreamRef.current = null }
    setShowQrScanner(false)
    setQrScanStatus('idle')
    setQrScanError('')
  }

  const handleQrScanResult = async (rawValue) => {
    stopQrScanner()
    setQrScanStatus('approving')
    setShowQrScanner(true)
    try {
      // rawValue is the full URL: {origin}/link-device?token=xxx
      let token = null
      try { token = new URL(rawValue).searchParams.get('token') } catch {}
      if (!token) token = rawValue.trim() // fallback: raw token string
      if (!token) throw new Error('Invalid QR code — no token found')

      const authToken = localStorage.getItem('token')
      const res = await fetch(apiUrl(`/api/auth/qr/${token}/approve`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || 'Approval failed')
      setQrScanStatus('done')
      fetchLinkedDevices()
    } catch (err) {
      setQrScanStatus('error')
      setQrScanError(err.message)
    }
  }

  const startQrScanner = async () => {
    setQrScanError('')
    setQrScanStatus('scanning')
    setShowQrScanner(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      qrStreamRef.current = stream
      // Attach stream to video element — need a small delay for the DOM to render
      setTimeout(() => {
        if (qrVideoRef.current) {
          qrVideoRef.current.srcObject = stream
          qrVideoRef.current.play().catch(() => {})
        }
      }, 100)

      if (!('BarcodeDetector' in window)) {
        // BarcodeDetector not available — show instructions to use native camera
        setQrScanError('AUTO_SCAN_UNSUPPORTED')
        return
      }
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      const scanFrame = async () => {
        if (!qrVideoRef.current || !qrStreamRef.current) return
        if (qrVideoRef.current.readyState < 2) { qrScanRafRef.current = requestAnimationFrame(scanFrame); return }
        try {
          const codes = await detector.detect(qrVideoRef.current)
          if (codes.length > 0) { handleQrScanResult(codes[0].rawValue); return }
        } catch {}
        qrScanRafRef.current = requestAnimationFrame(scanFrame)
      }
      qrScanRafRef.current = requestAnimationFrame(scanFrame)
    } catch (err) {
      setQrScanError(err.name === 'NotAllowedError' ? 'Camera permission denied. Please allow camera access.' : (err.message || 'Camera not available'))
      setQrScanStatus('error')
    }
  }

  // GIF search using Tenor v2
  const searchGifs = async (query) => {
    const key = import.meta.env.VITE_TENOR_API_KEY || ''
    if (!key) { setGifs([]); return }
    setGifLoading(true)
    try {
      const r = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query || 'trending')}&key=${key}&limit=20&media_filter=gif`)
      if (r.ok) { const d = await r.json(); setGifs(d.results || []) }
    } catch {} finally { setGifLoading(false) }
  }

  // Create group
  const createGroup = async () => {
    if (!newGroupName.trim() || newGroupMembers.length === 0) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(apiUrl('/api/groups'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newGroupName.trim(), member_ids: newGroupMembers }),
      })
      if (res.ok) {
        const g = await res.json()
        setGroups(prev => [g, ...prev])
        setShowCreateGroup(false); setNewGroupName(''); setNewGroupMembers([])
        setActiveId(`g_${g.id}`); setMobileShowChat(true)
      }
    } catch {}
  }

  // Send message to group
  const sendGroupMessage = async (gId, text) => {
    // Admin-only mode check (#11)
    if (groupAdminOnly[gId]) {
      const group = groups.find(g => g.id === gId)
      const memberEntry = group?.member_details?.find(m => m.id === user?.id)
      if (!memberEntry?.is_admin) { alert('Only admins can send messages in this group.'); return }
    }
    const token = localStorage.getItem('token')
    const myId = user?.id
    const gKey = `g_${gId}`
    const optimistic = { id: Date.now(), group_id: gId, from_user_id: myId, content: text, text, sender_name: user?.display_name || user?.username || '', sender_avatar: user?.avatar_url || '', created_at: new Date().toISOString(), pending: true, sent: true, time: nowTime() }
    setGroupMessages(prev => ({ ...prev, [gKey]: [...(prev[gKey] || []), optimistic] }))
    setReplyTo(null)
    try {
      const res = await fetch(apiUrl(`/api/groups/${gId}/messages`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: text }),
      })
      if (res.ok) {
        const s = await res.json()
        const _ts = s.created_at?.endsWith('Z') ? s.created_at : s.created_at + 'Z'
        const sNorm = { ...s, text: s.content, sent: true, time: new Date(_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), pending: false }
        setGroupMessages(prev => ({ ...prev, [gKey]: (prev[gKey] || []).map(m => m.id === optimistic.id ? sNorm : m) }))
        setGroups(prev => prev.map(g => g.id === gId ? { ...g, last_message: text, last_message_time: s.created_at } : g))
      }
    } catch {}
  }

  const deleteStatus = async (statusId) => {
    const token = localStorage.getItem('token')
    setStatusUpdates(prev => prev.filter(s => s.id !== statusId))
    try {
      await fetch(apiUrl(`/api/statuses/${statusId}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    } catch {}
  }

  const recordStatusView = async (statusIds, userId) => {
    const token = localStorage.getItem('token')
    for (const id of statusIds) {
      try {
        await fetch(apiUrl(`/api/statuses/${id}/view`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      } catch {}
    }
    if (userId) {
      setSeenStatusUsers(prev => {
        const next = new Set([...prev, String(userId)])
        localStorage.setItem('seen_status_users', JSON.stringify([...next]))
        return next
      })
      // Record when we viewed so new statuses posted after this time show as unread
      const seenTimes = (() => { try { return JSON.parse(localStorage.getItem('seen_status_times') || '{}') } catch { return {} } })()
      seenTimes[String(userId)] = new Date().toISOString()
      localStorage.setItem('seen_status_times', JSON.stringify(seenTimes))
    }
  }

  const postStatus = async () => {
    const text = myStatus.trim()
    if (statusPostType === 'video') { if (!statusVideoFile) return }
    else if (statusPostType === 'photo') { if (!statusImageFile) return }
    else { if (!text) return }
    const token = localStorage.getItem('token')
    setShowStatusModal(false)
    setStatusPosting(true)
    setStatusPostProgress(0)

    const startT = Date.now()
    const estMs = statusPostType === 'video' ? 8000 : 1800
    const prog = setInterval(() => {
      const pct = Math.min(90, ((Date.now() - startT) / estMs) * 100)
      setStatusPostProgress(pct)
    }, 50)

    let serverVideoUrl = null

    try {
      // Upload video or image to server first
      if (statusPostType === 'video' && statusVideoFile) {
        const formData = new FormData()
        formData.append('file', statusVideoFile)
        const uploadRes = await fetch(apiUrl('/api/upload?type=status'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
        if (uploadRes.ok) { const d = await uploadRes.json(); serverVideoUrl = d.url }
      }
      let serverImageUrl = null
      if (statusPostType === 'photo' && statusImageFile) {
        const formData = new FormData()
        formData.append('file', statusImageFile)
        const uploadRes = await fetch(apiUrl('/api/upload?type=status'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
        if (uploadRes.ok) { const d = await uploadRes.json(); serverImageUrl = d.url }
      }

      const chosenColor = statusBgColor || themeColor
      const optimistic = {
        id: Date.now(), content: text, text,
        type: statusPostType === 'video' ? 'video' : statusPostType === 'photo' ? 'image' : 'text',
        videoUrl: serverVideoUrl || statusVideoUrl || undefined,
        imageUrl: serverImageUrl || statusImageUrl || undefined,
        color: chosenColor, time: 'Just now',
        created_at: new Date().toISOString(), isMe: true,
        view_count: 0,
      }
      setStatusUpdates(prev => [optimistic, ...prev])
      // Reset image state
      setStatusImageFile(null); setStatusImageUrl(null)

      await fetch(apiUrl('/api/statuses'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: text || '', type: optimistic.type, color: chosenColor, video_url: serverVideoUrl, image_url: serverImageUrl }),
      })
      // Refresh status list from server so timestamps are accurate
      fetchStatusesRef.current?.()
    } catch {}

    clearInterval(prog)
    setStatusPostProgress(100)
    setTimeout(() => { setStatusPosting(false); setStatusPostProgress(0) }, 600)

    setMyStatus(''); setStatusVideoFile(null); setStatusVideoUrl(null)
    setStatusVideoError(''); setStatusPostType('text'); setShowStatusModal(false)
    setStatusEmojiOpen(false)
  }

  const handleVideoSelect = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setStatusVideoError('')
    const url = URL.createObjectURL(file)
    const vid = document.createElement('video')
    vid.preload = 'metadata'
    vid.src = url
    vid.onloadedmetadata = () => {
      if (vid.duration > 60) {
        URL.revokeObjectURL(url); setStatusVideoError('Video must be 60 seconds or less'); return
      }
      setStatusVideoFile(file); setStatusVideoUrl(url)
    }
    vid.onerror = () => { URL.revokeObjectURL(url); setStatusVideoError('Invalid video file — try another format') }
  }

  const openQuickProfile = () => {
    setEditName(user?.display_name || user?.username || '')
    setEditAbout(user?.about || 'Hey there! I am using SPVB.')
    setEditPhone(user?.phone || '')
    setShowQuickProfile(true)
  }

  const connectGoogleServices = () => {
    setGoogleConnecting(true)
    requestAllGooglePermissions(GOOGLE_CLIENT_ID, (token) => {
      setGoogleConnecting(false)
      if (token) {
        setGoogleConnectDone(true)
        setGmailToken(token)
        try { setGoogleContacts(JSON.parse(localStorage.getItem('google_contacts') || '[]')) } catch {}
      }
    })
  }

  const connectGmailOnly = () => {
    if (!GOOGLE_CLIENT_ID || !window.google?.accounts?.oauth2) return
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      callback: (r) => {
        if (r.access_token) {
          storeGmailToken(r.access_token, r.expires_in)
          setGmailToken(r.access_token)
        }
      },
    })
    tc.requestAccessToken({ prompt: 'consent' })
  }

  const connectContactsOnly = useCallback(async () => {
    if (!GOOGLE_CLIENT_ID || !window.google?.accounts?.oauth2) return
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/contacts.readonly',
      callback: async (r) => {
        if (r.access_token) {
          try {
            const contacts = await syncContactsWithToken(r.access_token)
            setGoogleContacts(contacts)
          } catch {}
        }
      },
    })
    tc.requestAccessToken({ prompt: 'consent' })
  }, [])

  // Fresh WS handler each render — captures latest state (activeCall, savedContactIds, etc.)
  wsHandlerRef.current = (event) => {
    let data
    try { data = JSON.parse(event.data) } catch { return }

    if (data.type === 'call_offer') {
      if (activeCall) {
        wsRef.current?.send(JSON.stringify({ type: 'call_reject', target: String(data.from) }))
        return
      }
      const fromId = parseInt(data.from)
      // Show caller info whether or not they're in contacts
      const fromC = spvbContactsRef.current.find(c => c.id === fromId)
      const displayName = fromC?.display_name || fromC?.username || `User ${fromId}`
      setIncomingCall({
        callType: data.callType,
        from: fromId,
        contact: {
          id: fromId,
          name: displayName,
          initials: displayName.slice(0, 2).toUpperCase(),
          color: AVATAR_COLORS[fromId % AVATAR_COLORS.length],
          avatar_url: fromC?.avatar_url || '',
        },
        sdp: data.sdp,
      })
      pendingIceCandidatesRef.current = [] // reset buffer for new incoming call
      _playRingtone() // start ringing when call comes in via WS
    }

    // Buffer ICE candidates that arrive while the incoming call banner is showing.
    // They'll be drained into the PC as soon as CallScreen mounts after acceptance.
    if (data.type === 'ice_candidate' && incomingCall && !activeCall) {
      pendingIceCandidatesRef.current.push(data.candidate)
    }

    // Another tab/device of THIS user already answered or rejected the call — dismiss here
    if (data.type === 'call_accepted_elsewhere' && incomingCall) {
      _dismissCallNotification(incomingCall.from)
      setIncomingCall(null)
      _stopRingtone()
    }

    if (data.type === 'call_end' && incomingCall && String(data.from) === String(incomingCall.from)) {
      saveCallLog({ contact_id: incomingCall.from, call_type: incomingCall.callType || 'voice', direction: 'incoming', status: 'missed', duration: 0 })
      _dismissCallNotification(incomingCall.from)
      setIncomingCall(null)
      _stopRingtone()
    }

    if (data.type === 'chat_message') {
      const msg = data.message
      if (!msg) return
      const fromId = msg.from_user_id
      const myId = user?.id
      const isSelfMsg = fromId === myId && msg.recipient_id === myId
      // Skip messages sent by me to others (already shown optimistically), but keep self-chat
      if (fromId === myId && !isSelfMsg) return
      const chatKey = isSelfMsg ? SELF_CHAT_ID : fromId
      const isActiveChat = activeIdRef.current === chatKey
      const ts = msg.created_at?.endsWith('Z') ? msg.created_at : msg.created_at + 'Z'
      const timeStr = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      // Decrypt message if E2E encrypted (async — update state after)
      const rawContent = msg.content || ''
      const addMsg = (plainText) => {
        setLiveMessages(prev => {
          const existing = prev[chatKey] || []
          if (existing.some(m => !m.pending && m.id === msg.id)) return prev
          const cleaned = existing.filter(em =>
            !(em.pending && em.from_user_id === fromId && em.text === plainText)
          )
          return {
            ...prev,
            [chatKey]: [...cleaned, {
              id: msg.id, text: plainText,
              created_at: ts,
              media_url: msg.media_url || null, media_type: msg.media_type || null, fileName: msg.file_name || null,
              replyTo: msg.reply_to || null,
              sent: isSelfMsg, time: timeStr,
              read: isActiveChat, status: msg.status || 'sent', pending: false, from_user_id: fromId,
              _raw: msg,
              _encrypted: String(plainText || '').startsWith('__e2e__|') || String(plainText || '').startsWith('__e2ev2__|'),
            }],
          }
        })
        if (!isSelfMsg) setRecentConversations(prev => ({ ...prev, [fromId]: { lastMsg: plainText, time: timeStr, fromMe: false } }))
      }
      if (rawContent.startsWith('__e2e__|') || rawContent.startsWith('__e2ev2__|')) {
        waitForE2eKey().then(async () => {
          // V2: RSA-OAEP wrapped key present — use it directly
          const v2Priv = v2PrivKeyRef.current
          if (v2Priv && isV2Message(msg)) {
            const wrappedKey = msg.encrypted_key_for_receiver
            const plain = await decryptMessageWithWrappedKey(rawContent, wrappedKey, v2Priv)
            addMsg(plain)
            return
          }
          // V1: ECDH shared key fallback
          const key = e2ePrivKeyRef.current
          if (!key) { addMsg(rawContent); return }
          const theirPub = await getContactPubKey(fromId)
          const plain = await decryptMessage(rawContent, key, theirPub)
          // If still cipher (their pub key not available yet), store cipher and retry in 3s
          if (String(plain || '').startsWith('__e2e__|')) {
            addMsg(plain)
            setTimeout(async () => {
              const k2 = e2ePrivKeyRef.current
              if (!k2) return
              const pub2 = await getContactPubKey(fromId)
              if (!pub2) return
              const plain2 = await decryptMessage(rawContent, k2, pub2)
              if (!String(plain2 || '').startsWith('__e2e__|')) {
                setLiveMessages(prev => {
                  const thread = prev[fromId] || prev[String(fromId)]
                  if (!thread) return prev
                  const key2 = fromId in prev ? fromId : String(fromId)
                  return { ...prev, [key2]: thread.map(m => m.text === plain ? { ...m, text: plain2, _encrypted: false } : m) }
                })
              }
            }, 3000)
          } else {
            addMsg(plain)
          }
        })
      } else {
        addMsg(rawContent)
      }
      if (isActiveChat) {
        const token = localStorage.getItem('token')
        if (!isSelfMsg) fetch(apiUrl(`/api/messages/read/${fromId}`), { method: 'PUT', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      } else if (!isSelfMsg) {
        setUnreadCounts(prev => ({ ...prev, [Number(fromId)]: (prev[Number(fromId)] || 0) + 1 }))
        // Show in-app toast notification (WhatsApp-style)
        const senderContact = spvbContactsRef.current.find(c => String(c.id || c.user_id) === String(fromId))
        const senderName = senderContact?.display_name || senderContact?.username || `User ${fromId}`
        const senderColor = AVATAR_COLORS[Number(fromId) % AVATAR_COLORS.length]
        const showToast = (plainText) => {
          const displayText = String(plainText).startsWith('__e2e__|') ? 'New message' : plainText
          const toastPayload = { name: senderName, text: displayText, contactId: fromId, color: senderColor }

          // Fire OS notification only when the app is not in the foreground
          if (Notification.permission === 'granted' && notifEnabled && document.visibilityState !== 'visible') {
            const notifOpts = {
              body: displayText,
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: `spvb-${fromId}`,
              renotify: true,
              silent: !notifSoundRef.current,
              data: { contactId: fromId },
            }
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
              // SW path — shows notification even when page is fully suspended on mobile
              navigator.serviceWorker.ready.then(reg => {
                reg.showNotification(senderName, notifOpts).catch(() => {
                  // Fallback to direct Notification API
                  try { const n = new Notification(senderName, notifOpts); n.onclick = () => { window.focus(); setActiveId(Number(fromId) || fromId); n.close() } } catch {}
                })
              }).catch(() => {})
            } else {
              // No SW (plain browser) — direct Notification API
              try { const n = new Notification(senderName, notifOpts); n.onclick = () => { window.focus(); setActiveId(Number(fromId) || fromId); n.close() } } catch {}
            }
          }

          if (document.visibilityState === 'visible') {
            // Page is visible → show in-app toast immediately
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
            setInAppToast(toastPayload)
            toastTimerRef.current = setTimeout(() => setInAppToast(null), 5000)
          } else {
            // Page hidden → queue toast so user sees it when they return
            pendingToastsRef.current.push(toastPayload)
          }

          // Notification sound — use per-contact ringtone
          _playNotifSound(fromId)
        }
        // Wait for decryption if needed, then show toast
        if (rawContent.startsWith('__e2e__|')) {
          waitForE2eKey().then(() => {
            const key = e2ePrivKeyRef.current
            if (!key) { showToast(rawContent); return }
            getContactPubKey(fromId).then(theirPub =>
              decryptMessage(rawContent, key, theirPub).then(plain => showToast(plain))
            )
          })
        } else {
          showToast(rawContent)
        }
      }
    }

    if (data.type === 'read_receipt') {
      // data.by = the user who READ our messages (they opened our chat)
      // Mark all sent messages in that thread as seen → blue double ticks
      const readById = String(data.by || '')
      if (!readById) return
      setLiveMessages(prev => {
        const thread = prev[readById]
        if (!thread) return prev
        const anyChanged = thread.some(m => m.sent && (!m.read || m.status !== 'seen'))
        if (!anyChanged) return prev  // bail early — no re-render needed
        return {
          ...prev,
          [readById]: thread.map(m =>
            m.sent ? { ...m, read: true, status: 'seen', pending: false } : m
          ),
        }
      })
    }

    if (data.type === 'message_delivered') {
      // Server confirmed message reached the recipient's device → double grey ticks
      const deliveredIds = new Set((data.message_ids || []).map(Number))
      if (!deliveredIds.size) return
      setLiveMessages(prev => {
        let changed = false
        const updated = {}
        for (const [k, msgs] of Object.entries(prev)) {
          const next = msgs.map(m => {
            if (deliveredIds.has(Number(m.id)) && m.status !== 'delivered' && m.status !== 'seen') {
              changed = true
              return { ...m, status: 'delivered', pending: false }
            }
            return m
          })
          updated[k] = next
        }
        return changed ? updated : prev  // bail early if nothing changed
      })
    }

    if (data.type === 'message_deleted') {
      const deletedId = data.message_id
      setLiveMessages(prev => {
        const updated = {}
        for (const [k, msgs] of Object.entries(prev)) updated[k] = msgs.filter(m => m.id !== deletedId)
        return updated
      })
    }

    if (data.type === 'typing') {
      const fromId = String(data.from)
      setTypingUsers(prev => ({ ...prev, [fromId]: true }))
      clearTimeout(typingTimersRef.current[fromId])
      typingTimersRef.current[fromId] = setTimeout(() => {
        setTypingUsers(prev => { const n = { ...prev }; delete n[fromId]; return n })
      }, 3000)
    }

    if (data.type === 'group_message') {
      const msg = data.message
      if (!msg) return
      const gKey = `g_${data.group_id}`
      const _myId = user?.id
      const _ts = msg.created_at?.endsWith('Z') ? msg.created_at : msg.created_at + 'Z'
      const normalizedMsg = { ...msg, text: msg.content, sent: msg.from_user_id === _myId, time: new Date(_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
      setGroupMessages(prev => {
        const existing = prev[gKey] || []
        if (existing.some(m => m.id === msg.id)) return prev
        return { ...prev, [gKey]: [...existing, normalizedMsg] }
      })
      setGroups(prev => prev.map(g => g.id === data.group_id ? { ...g, last_message: msg.content || '', last_message_time: msg.created_at } : g))
    }

    if (data.type === 'group_created') {
      const g = data.group
      if (g) setGroups(prev => prev.some(x => x.id === g.id) ? prev : [g, ...prev])
    }

    if (data.type === 'new_status') {
      const s = data.status
      if (!s) return
      const fmt = (iso) => {
        try {
          const d = new Date(iso), now = new Date()
          if (d.toDateString() === now.toDateString())
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        } catch { return '' }
      }
      setContactStatuses(prev => {
        const existing = prev.find(g => g.userId === s.user_id)
        const newItem = { id: s.id, content: s.content, type: s.type, color: s.color, videoUrl: s.video_url, time: fmt(s.created_at), created_at: s.created_at }
        if (existing) {
          return prev.map(g => g.userId === s.user_id ? { ...g, statuses: [...g.statuses, newItem] } : g)
        }
        return [...prev, {
          userId: s.user_id,
          name: s.display_name || s.username || `User ${s.user_id}`,
          initials: (s.display_name || s.username || 'U').slice(0, 2).toUpperCase(),
          color: AVATAR_COLORS[s.user_id % AVATAR_COLORS.length],
          avatar_url: s.avatar_url || '',
          statuses: [newItem],
        }]
      })
    }

    if (data.type === 'qr_link_request') {
      setQrLinkRequest({ token: data.token, device_name: data.device_name, user_agent: data.user_agent })
    }

    if (data.type === 'user_status') {
      const uid = String(data.user_id)
      // Ignore presence updates from blocked users — privacy fix
      if (blockedIds.has(Number(uid))) return
      // Real-time presence update — no polling needed, instant status change
      setOnlineMap(prev => ({
        ...prev,
        [uid]: {
          ...(prev[uid] || {}),
          online_status: data.status,
          updated_at: data.last_seen || new Date().toISOString(),
        },
      }))
      if (data.status === 'online') {
        lastSeenRef.current[uid] = new Date().toISOString()
        // Contact just came online — clear both v1 and v2 pubkey caches
        delete contactPubKeysRef.current[uid]
        delete contactPubKeysRef.current[`pubkey_v2_${uid}`]
        try { localStorage.removeItem(`pubkey_${uid}`) } catch {}
        try { localStorage.removeItem(`pubkey_v2_${uid}`) } catch {}
        const privKey = e2ePrivKeyRef.current
        if (privKey || v2PrivKeyRef.current) {
          setTimeout(() => decryptAllPending(privKey), 500)
          setTimeout(() => decryptAllPending(privKey), 2500)
        }
      }
    }

    if (data.type === 'force_logout') {
      const mySessionId = localStorage.getItem('session_id')
      if (data.session_id && data.session_id !== mySessionId) return
      // Run the full logout cleanup (clears cache, push, cookies, etc.)
      logout()
    }
  }

  // ── window.spvbDiag() — run in browser console to get E2E investigation report ──
  if (typeof window !== 'undefined') {
    window.spvbDiag = async () => {
      const uid   = user?.id
      const token = localStorage.getItem('token')
      const report = { userId: uid, timestamp: new Date().toISOString(), checks: {} }

      // 1. IndexedDB key check (using raw IndexedDB API — no import needed)
      try {
        const stored = await new Promise((resolve, reject) => {
          const req = indexedDB.open('spvb_e2e', 1)
          req.onerror = () => reject(req.error)
          req.onsuccess = e => {
            const db  = e.target.result
            const tx  = db.transaction('keys', 'readonly')
            const get = tx.objectStore('keys').get(`keypair_${uid}`)
            get.onsuccess = () => resolve(get.result)
            get.onerror   = () => reject(get.error)
          }
        })
        if (stored) {
          const pub = JSON.parse(stored.publicKey)
          report.checks.indexedDB = { status: 'OK', pubkey_x: pub.x?.slice(0,12) + '…', has_private: !!stored.privateKey }
        } else {
          report.checks.indexedDB = { status: 'MISSING — no keypair in IndexedDB' }
        }
      } catch (e) { report.checks.indexedDB = { status: 'ERROR', error: e.message } }

      // 2. Server pubkey check
      try {
        const res = await fetch(`/api/users/${uid}/pubkey`, { headers: { Authorization: `Bearer ${token}` } })
        const data = await res.json()
        const serverX = data.pubkey ? JSON.parse(data.pubkey).x?.slice(0,12) + '…' : null
        const localX  = report.checks.indexedDB?.pubkey_x
        report.checks.serverPubkey = {
          status:   data.pubkey ? (serverX === localX ? 'OK — matches IndexedDB' : 'MISMATCH — different from IndexedDB!') : 'MISSING — no pubkey on server',
          server_x: serverX,
          local_x:  localX,
        }
      } catch (e) { report.checks.serverPubkey = { status: 'FETCH ERROR', error: e.message } }

      // 3. Key backup check
      try {
        const res  = await fetch('/api/users/me/key-backup', { headers: { Authorization: `Bearer ${token}` } })
        const data = await res.json()
        report.checks.keyBackup = { status: data.backup ? 'OK — backup exists on server' : 'MISSING — no backup (new device cannot restore key)' }
      } catch (e) { report.checks.keyBackup = { status: 'FETCH ERROR', error: e.message } }

      // 4. Memory key check
      report.checks.memoryKey = {
        status:    e2ePrivKeyRef.current ? 'OK — key loaded in memory' : 'MISSING — e2ePrivKeyRef is null',
        e2eReady:  e2eReadyRef.current,
      }

      // 5. Contact pubkey check (active chat)
      if (activeIdRef.current) {
        const cid  = String(activeIdRef.current)
        const cached = contactPubKeysRef.current[cid] || localStorage.getItem(`pubkey_${cid}`)
        report.checks.contactPubkey = {
          contactId: cid,
          cached:    !!cached,
          key_x:     cached ? (() => { try { return JSON.parse(cached).x?.slice(0,12) + '…' } catch { return 'parse-error' } })() : null,
        }
      }

      // 6. Encrypted message count in current view
      const allMsgs   = Object.values(liveMessagesRef.current).flat()
      const encrypted = allMsgs.filter(m => String(m.text || '').startsWith('__e2e__|'))
      report.checks.messages = {
        total_loaded:   allMsgs.length,
        still_encrypted: encrypted.length,
        decrypted:      allMsgs.length - encrypted.length,
      }

      // 7. Admin server report (if admin)
      try {
        const res  = await fetch('/api/admin/e2e-report', { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) report.serverReport = await res.json()
      } catch {}

      console.log('═══════════ SPVB E2E DIAGNOSTIC REPORT ═══════════')
      console.log(JSON.stringify(report, null, 2))
      console.log('═══════════════════════════════════════════════════')

      // Verdict
      const issues = []
      if (report.checks.indexedDB?.status !== 'OK') issues.push('❌ ' + report.checks.indexedDB?.status)
      if (!report.checks.serverPubkey?.status?.startsWith('OK')) issues.push('❌ ' + report.checks.serverPubkey?.status)
      if (!report.checks.keyBackup?.status?.startsWith('OK')) issues.push('⚠️  ' + report.checks.keyBackup?.status)
      if (!report.checks.memoryKey?.status?.startsWith('OK')) issues.push('❌ ' + report.checks.memoryKey?.status)
      if (issues.length === 0) {
        console.log('✅ All E2E checks passed — if messages still fail, check [E2E:Decrypt] logs above')
      } else {
        console.log('Issues found:')
        issues.forEach(i => console.log(' ', i))
      }
      return report
    }
  }

  if (!user) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#111b21', flexDirection: 'column', gap: 16 }}>
      <div style={{ width: 40, height: 40, border: '3px solid rgba(0,168,132,0.2)', borderTopColor: '#00a884', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <span style={{ color: '#8696a0', fontSize: 14 }}>Loading...</span>
    </div>
  )

  // Dark mode color helpers used in inline styles
  const dm = {
    bg: darkMode ? '#111b21' : '#f0f2f5',
    sidebar: darkMode ? '#111b21' : '#ffffff',
    header: darkMode ? '#202c33' : '#f0f2f5',
    panel: darkMode ? '#202c33' : '#ffffff',
    bubble_sent: darkMode ? '#005c4b' : '#d9fdd3',
    bubble_recv: darkMode ? '#202c33' : '#ffffff',
    input: darkMode ? '#2a3942' : '#ffffff',
    text: darkMode ? '#e9edef' : '#111b21',
    subtext: darkMode ? '#8696a0' : '#667781',
    border: darkMode ? 'rgba(134,150,160,0.1)' : 'rgba(0,0,0,0.08)',
    hover: darkMode ? '#2a3942' : '#f5f6f6',
    active: darkMode ? '#2a3942' : '#f0f2f5',
    settingsBg: darkMode ? '#111b21' : '#f0f2f5',
    rowBg: darkMode ? '#202c33' : '#ffffff',
    rowHover: darkMode ? '#1e2d35' : '#f5f6f6',
    msgsBg: darkMode ? '#0b141a' : '#efeae2',
  }

  return (
    <div className="wa-app" data-theme={darkMode ? 'dark' : 'light'}>

      {/* ── In-app toast notification (WhatsApp-style) ── */}
      {inAppToast && (
        <div
          onClick={() => { setInAppToast(null); setActiveId(Number(inAppToast.contactId) || inAppToast.contactId) }}
          style={{
            position: 'fixed', top: 16, right: 16, zIndex: 9999,
            background: '#1e2b33', borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
            minWidth: 260, maxWidth: 340, cursor: 'pointer',
            animation: 'slideInRight 0.3s ease',
            borderLeft: `4px solid ${inAppToast.color}`,
          }}
        >
          <div style={{ width: 42, height: 42, borderRadius: '50%', background: inAppToast.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
            {inAppToast.name?.charAt(0)?.toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: '#e9edef', fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{inAppToast.name}</div>
            <div style={{ color: '#8696a0', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inAppToast.text}</div>
          </div>
          <button onClick={e => { e.stopPropagation(); setInAppToast(null) }} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 4, fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* ── SIDEBAR ── */}
      <div className={`wa-sidebar${mobileShowChat ? ' mobile-hidden' : ''}`}
        onTouchStart={(e) => { tabSwipeStartX.current = e.touches[0].clientX; tabSwipeStartY.current = e.touches[0].clientY }}
        onTouchEnd={(e) => {
          if (tabSwipeStartX.current === null) return
          const dx = e.changedTouches[0].clientX - tabSwipeStartX.current
          const dy = e.changedTouches[0].clientY - tabSwipeStartY.current
          tabSwipeStartX.current = null
          if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.8) return
          const idx = TABS.indexOf(tab)
          if (dx < 0 && idx < TABS.length - 1) setTab(TABS[idx + 1])
          else if (dx > 0 && idx > 0) setTab(TABS[idx - 1])
        }}
      >
        {/* Header */}
        <div className="wa-sidebar-header">
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* User avatar — tap to open account switcher (WhatsApp style) */}
            <button onClick={() => { saveCurrentAccount(); setShowAccountSwitcher(true) }} title="Switch account"
              style={{ position: 'relative', width: 38, height: 38, borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', background: 'none', flexShrink: 0 }}>
              <div style={{ width: 38, height: 38, borderRadius: '50%', overflow: 'hidden', background: themeGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16 }}>
                {user?.avatar_url
                  ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : (user?.display_name || user?.username || 'U')[0].toUpperCase()}
              </div>
              {savedAccounts.filter(a => a.id !== user?.id).length > 0 && (
                <div style={{ position: 'absolute', bottom: 0, right: 0, width: 14, height: 14, borderRadius: '50%', background: themeColor, border: '2px solid #111b21', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: '#fff', fontWeight: 700 }}>
                  {savedAccounts.filter(a => a.id !== user?.id).length}
                </div>
              )}
            </button>
            <div style={{ color: '#e9edef', fontWeight: 700, fontSize: 15, letterSpacing: 0.5 }}>SPVB</div>
          </div>
          <div className="wa-header-icons">
            <button className="wa-icon-btn" title="Add contact by phone" onClick={() => setShowAddContact(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
            </button>
            <button className="wa-icon-btn" title="New Group" onClick={() => setShowCreateGroup(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </button>
            <button className="wa-icon-btn" title="New chat" onClick={() => setTab('chats')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="10" y1="10" x2="14" y2="10"/></svg>
            </button>
            <button className="wa-icon-btn" title="Starred Messages" onClick={() => setShowStarredPanel(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
            <button className="wa-icon-btn" title="Settings" onClick={() => { setShowSettings(true); setSettingsPage(null) }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>
        </div>

        {/* Tab bar */}
        {(() => {
          const totalUnread = Object.values(unreadCounts).reduce((s, v) => s + (v || 0), 0)
          return (
            <div style={{ display: 'flex', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              {[{ id: 'chats', label: 'Chats' }, { id: 'status', label: 'Status' }, { id: 'calls', label: 'Calls' }, { id: 'mail', label: '✉ Mail' }].map(({ id, label }) => (
                <button key={id} onClick={() => { setTab(id); if (id !== 'chats') setShowArchivedList(false) }} style={{ flex: 1, padding: '12px 0', background: 'none', border: 'none', borderBottom: tab === id ? `2px solid ${themeColor}` : '2px solid transparent', color: tab === id ? themeColor : '#8696a0', fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  {label}
                  {id === 'chats' && totalUnread > 0 && tab !== 'chats' && (
                    <span className="wa-tab-badge">{totalUnread > 99 ? '99+' : totalUnread}</span>
                  )}
                </button>
              ))}
            </div>
          )
        })()}

        {/* Search */}
        {tab === 'chats' && !showArchivedList && (
          <div className="wa-search">
            <div className="wa-search-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" placeholder="Search or start new chat" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        )}

        {/* ── GOOGLE CONNECT BANNER (email users only) ── */}
        {tab === 'chats' && !showArchivedList && !googleConnectDone && GOOGLE_CLIENT_ID && (
          <div className="wa-google-banner">
            <div className="wa-google-banner-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4285f4" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
              Connect Google Services
            </div>
            <div className="wa-google-banner-sub">Access Gmail right inside SPVB.</div>
            <div className="wa-google-banner-btns">
              <button className="wa-google-banner-btn" onClick={connectGmailOnly} style={{ background: 'rgba(234,67,53,0.12)', color: '#ea4335', border: '1px solid rgba(234,67,53,0.25)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                Gmail
              </button>
              <button className="wa-google-banner-btn" onClick={connectGoogleServices} disabled={googleConnecting} style={{ background: 'rgba(66,133,244,0.15)', color: '#4285f4', border: '1px solid rgba(66,133,244,0.3)' }}>
                {googleConnecting ? '…' : '⚡ Both'}
              </button>
              <button className="wa-google-banner-btn" onClick={() => setGoogleConnectDone(true)} style={{ background: 'transparent', color: '#8696a0', border: '1px solid rgba(134,150,160,0.2)' }}>✕</button>
            </div>
          </div>
        )}

        {/* ── CHATS TAB ── */}
        {tab === 'chats' && (
          <div className="wa-chat-list">
            {/* Decryption banner removed — spinners inside each bubble are sufficient */}
            {/* Password prompt removed — decryption is always silent and automatic */}
            {contactsLoading && spvbContacts.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: '#8696a0', fontSize: 13 }}>
                <div style={{ width: 24, height: 24, border: '2px solid rgba(0,168,132,0.3)', borderTopColor: themeColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 8px' }} />
                <div>Loading contacts…</div>
                <div style={{ fontSize: 11, color: '#4a5568', marginTop: 6 }}>Server may be warming up, please wait</div>
                {/* Skeleton rows */}
                {[1,2,3,4].map(i => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', opacity: 0.35 }}>
                    <div style={{ width: 49, height: 49, borderRadius: '50%', background: '#2a3942', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ width: '60%', height: 13, borderRadius: 6, background: '#2a3942', marginBottom: 8 }} />
                      <div style={{ width: '80%', height: 11, borderRadius: 6, background: '#2a3942' }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Archived view header */}
            {showArchivedList && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: '#1e2d35', borderBottom: '1px solid rgba(134,150,160,0.1)', position: 'sticky', top: 0, zIndex: 2 }}>
                <button onClick={() => setShowArchivedList(false)} style={{ background: 'none', border: 'none', color: themeColor, cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, fontFamily: 'inherit' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                  Archived
                </button>
                <span style={{ color: '#8696a0', fontSize: 12, marginLeft: 'auto' }}>{archivedChats.size} chat{archivedChats.size !== 1 ? 's' : ''}</span>
              </div>
            )}
            {[...(showArchivedList ? [] : [selfContact, botContact, ...groupContacts.filter(g => g.name.toLowerCase().includes(search.toLowerCase()))]), ...filteredContacts].map((c) => {
              const st = getContactStatus(c)
              const cId = String(c.id)
              const hasSt = contactStatuses.some(g => String(g.userId) === cId)
              const seenSt = seenStatusUsers.has(cId)
              const ringColor = hasSt ? (seenSt ? 'rgba(134,150,160,0.45)' : themeColor) : 'transparent'
              return (
                <div key={c.id} className={`wa-chat-item${activeId === c.id ? ' active' : ''}`} onClick={() => c.isInvite ? inviteContact(c) : selectChat(c.id)}
                  onContextMenu={e => {
                    if (c.id === 'bot' || c.id === SELF_CHAT_ID || c.isInvite) return
                    e.preventDefault()
                    setMsgMenuPos({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 200) })
                    // Use msgMenuId with a special prefix to distinguish chat-list context menu
                    setMsgMenuId(`chat_ctx_${c.id}`)
                  }}>
                  <div
                    onClick={(e) => {
                      if (c.isInvite || c.id === 'bot') return
                      e.stopPropagation()
                      if (hasSt) {
                        const stGroup = contactStatuses.find(g => String(g.userId) === cId)
                        if (stGroup) { recordStatusView(stGroup.statuses.map(s => s.id), cId); setViewingStatusGroups([stGroup]); setViewingStatusStart(0) }
                      } else {
                        setProfilePopupContact(c)
                        setShowProfileImagePopup(true)
                      }
                    }}
                    style={{ position: 'relative', flexShrink: 0, width: 49, height: 49,
                    borderRadius: '50%',
                    background: hasSt ? (seenSt ? 'rgba(134,150,160,0.45)' : `conic-gradient(${themeColor} 0%, #25d366 100%)`) : 'transparent',
                    padding: hasSt ? 2 : 0,
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                  }}>
                    <div className="wa-chat-avatar" style={{ background: c.color, position: 'relative', width: '100%', height: '100%', border: hasSt ? '2px solid #111b21' : 'none', boxSizing: 'border-box' }}>
                      {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : c.id === 'bot' ? '🤖' : c.initials}
                      {st.isOnline && <div style={{ position: 'absolute', bottom: 1, right: 1, width: 10, height: 10, background: '#25d366', borderRadius: '50%', border: '2px solid #111b21' }} />}
                    </div>
                  </div>
                  <div className="wa-chat-info">
                    <div className="wa-chat-top">
                      <span className={`wa-chat-name${c.unread > 0 ? ' has-unread' : ''}`}>{c.name}</span>
                    </div>
                    <div className="wa-chat-bottom">
                      <span className={`wa-chat-last${c.unread > 0 ? ' has-unread' : ''}`} style={{ color: c.isInvite ? '#4285f4' : undefined }}>
                        {c.isInvite ? '📨 Tap to invite' : c.lastMsg}
                      </span>
                    </div>
                  </div>
                  {/* Right meta column: time (top) + badge (bottom) */}
                  <div className="wa-chat-meta">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {pinnedChatIds.has(String(c.id)) && <svg width="12" height="12" viewBox="0 0 24 24" fill="#8696a0"><path d="M16 1v8l2 2-8 8-2-2H1l8-8 2 2V1h5z"/></svg>}
                      <span className={`wa-chat-time${c.unread > 0 ? ' has-unread' : ''}`}>{c.time}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                      {chatLabels[String(c.id)] && (() => { const ldef = LABEL_DEFS.find(l => l.id === chatLabels[String(c.id)]); return ldef ? <span style={{ fontSize: 9, background: ldef.color + '33', color: ldef.color, borderRadius: 4, padding: '1px 5px', fontWeight: 600 }}>{ldef.label}</span> : null })()}
                      {c.unread > 0
                        ? <span className="wa-unread-badge">{c.unread > 99 ? '99+' : c.unread}</span>
                        : <span style={{ height: 18 }} />
                      }
                    </div>
                  </div>
                </div>
              )
            })}
            {!contactsLoading && filteredContacts.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: '#8696a0', fontSize: 13 }}>
                {showArchivedList ? 'No archived chats.' : <><span>No contacts found.</span><br /><span style={{ fontSize: 12 }}>AI Assistant is always available in your chats.</span></>}
              </div>
            )}
            {/* Archived folder row — shown at bottom of main list (WhatsApp style) */}
            {!showArchivedList && archivedChats.size > 0 && !search && (
              <div onClick={() => setShowArchivedList(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', cursor: 'pointer', borderTop: '1px solid rgba(134,150,160,0.08)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
                onMouseLeave={e => e.currentTarget.style.background = ''}>
                <div style={{ width: 49, height: 49, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#e9edef', fontSize: 15, fontWeight: 500 }}>Archived</div>
                </div>
                <span style={{ color: themeColor, fontSize: 12, fontWeight: 600 }}>{archivedChats.size}</span>
              </div>
            )}
          </div>
        )}

        {/* ── STATUS TAB ── */}
        {tab === 'status' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* My Status */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <div style={{ color: '#8696a0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>My Status</div>

              {/* Upload progress bar */}
              {statusPosting && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <div style={{ width: 16, height: 16, border: `2px solid ${themeColor}33`, borderTopColor: themeColor, borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
                    <span style={{ color: themeColor, fontSize: 12, fontWeight: 600 }}>
                      {statusPostProgress < 100 ? `Posting… ${Math.round(statusPostProgress)}%` : 'Posted!'}
                    </span>
                  </div>
                  <div style={{ height: 3, background: 'rgba(134,150,160,0.15)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 2,
                      background: `linear-gradient(90deg, ${themeColor}, #25d366)`,
                      width: `${statusPostProgress}%`,
                      transition: 'width 0.1s linear',
                      boxShadow: `0 0 6px ${themeColor}88`,
                    }} />
                  </div>
                </div>
              )}

              {/* Avatar + add button row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ position: 'relative', cursor: 'pointer', flexShrink: 0 }}
                  onClick={() => {
                    if (statusPosting) return
                    if (statusUpdates.length > 0) {
                      setViewingStatusGroups([{
                        userId: user.id, name: 'My Status',
                        initials: userInitial, color: themeColor, avatar_url: user.avatar_url || '',
                        statuses: statusUpdates.map(s => ({ ...s, content: s.text || s.content || '' })),
                      }])
                      setViewingStatusStart(0)
                    } else { setShowStatusModal(true) }
                  }}
                >
                  <div style={{
                    width: 50, height: 50, borderRadius: '50%',
                    background: themeGradient,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'white', fontWeight: 700, fontSize: 18, overflow: 'hidden',
                    border: statusUpdates.length > 0 ? `2.5px solid ${themeColor}` : '2.5px dashed rgba(134,150,160,0.4)',
                    boxShadow: statusUpdates.length > 0 ? `0 0 0 2px #111b21, 0 0 0 4px ${themeColor}` : 'none',
                    opacity: statusPosting ? 0.6 : 1,
                  }}>
                    {user.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : userInitial}
                  </div>
                  {statusPosting && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: 20, height: 20, border: `2px solid rgba(255,255,255,0.3)`, borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                    </div>
                  )}
                  {!statusPosting && (
                    <div onClick={(e) => { e.stopPropagation(); setShowStatusModal(true) }} style={{
                      position: 'absolute', bottom: -2, right: -2,
                      width: 20, height: 20, borderRadius: '50%',
                      background: themeColor, border: '2px solid #111b21',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, cursor: statusPosting ? 'default' : 'pointer' }}
                  onClick={() => {
                    if (statusPosting) return
                    if (statusUpdates.length > 0) {
                      setViewingStatusGroups([{
                        userId: user.id, name: 'My Status',
                        initials: userInitial, color: themeColor, avatar_url: user.avatar_url || '',
                        statuses: statusUpdates.map(s => ({ ...s, content: s.text || s.content || '' })),
                      }])
                      setViewingStatusStart(0)
                    } else { setShowStatusModal(true) }
                  }}>
                  <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 500 }}>My Status</div>
                  <div style={{ color: statusPosting ? themeColor : '#8696a0', fontSize: 12 }}>
                    {statusPosting
                      ? `Uploading ${Math.round(statusPostProgress)}%`
                      : statusUpdates.length > 0
                        ? `${statusUpdates.length} update${statusUpdates.length > 1 ? 's' : ''} · ${statusUpdates[0].time || 'Just now'}`
                        : 'Tap to add status update'}
                  </div>
                </div>
              </div>

            </div>

            {/* Other contacts' statuses — split into Recent and Viewed */}
            {(() => {
              const unseenGroups = contactStatuses.filter(g => !seenStatusUsers.has(String(g.userId)))
              const seenGroups   = contactStatuses.filter(g => seenStatusUsers.has(String(g.userId)))

              const renderStatusRow = (group, gi, allGroups, isSeen) => (
                <div
                  key={group.userId}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', cursor: 'pointer', borderBottom: '1px solid rgba(134,150,160,0.07)' }}
                  onClick={() => {
                    recordStatusView(group.statuses.map(s => s.id), group.userId)
                    setViewingStatusGroups(allGroups)
                    setViewingStatusStart(gi)
                  }}
                >
                  {/* Avatar ring: green gradient = unseen, grey = seen */}
                  <div style={{
                    width: 54, height: 54, borderRadius: '50%', flexShrink: 0,
                    background: isSeen
                      ? 'rgba(134,150,160,0.35)'
                      : `conic-gradient(${themeColor} 0%, #25d366 100%)`,
                    padding: 2.5, boxSizing: 'border-box',
                  }}>
                    <div style={{
                      width: '100%', height: '100%', borderRadius: '50%',
                      background: group.color,
                      border: '2px solid #111b21',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'white', fontWeight: 700, fontSize: 17, overflow: 'hidden',
                      boxSizing: 'border-box',
                    }}>
                      {group.avatar_url
                        ? <img src={group.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : group.initials}
                    </div>
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: isSeen ? '#8696a0' : '#e9edef', fontSize: 14, fontWeight: isSeen ? 400 : 500 }}>{group.name}</div>
                    <div style={{ color: '#8696a0', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {group.statuses[group.statuses.length - 1]?.time || ''} · {group.statuses[group.statuses.length - 1]?.content?.substring(0, 28) || (group.statuses[group.statuses.length - 1]?.type === 'video' ? '📹 Video' : '')}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    {group.statuses.length > 1 && (
                      <div style={{ background: isSeen ? 'rgba(134,150,160,0.15)' : `${themeColor}22`, color: isSeen ? '#8696a0' : themeColor, fontSize: 11, fontWeight: 700, borderRadius: 10, padding: '2px 8px', border: `1px solid ${isSeen ? 'rgba(134,150,160,0.2)' : themeColor + '44'}` }}>
                        {group.statuses.length}
                      </div>
                    )}
                    {isSeen && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                      </svg>
                    )}
                  </div>
                </div>
              )

              return (
                <>
                  {unseenGroups.length > 0 && (
                    <div style={{ padding: '12px 16px' }}>
                      <div style={{ color: '#8696a0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Recent Updates</div>
                      {unseenGroups.map((g, gi) => renderStatusRow(g, gi, unseenGroups, false))}
                    </div>
                  )}

                  {seenGroups.length > 0 && (
                    <div style={{ padding: '12px 16px' }}>
                      <div style={{ color: '#8696a0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Viewed Updates</div>
                      {seenGroups.map((g, gi) => renderStatusRow(g, gi, seenGroups, true))}
                    </div>
                  )}

                  {contactStatuses.length === 0 && statusUpdates.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '40px 20px', color: '#8696a0' }}>
                      <div style={{ fontSize: 40, marginBottom: 10 }}>👁</div>
                      <div style={{ fontSize: 14 }}>No status updates yet</div>
                      <div style={{ fontSize: 12, marginTop: 4 }}>Post yours or wait for contacts</div>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        )}

        {/* ── CALLS TAB ── */}
        {tab === 'calls' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* Phone contact sync banner */}
            <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(134,150,160,0.08)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={syncPhoneContacts} disabled={syncingContacts} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 14px', background: syncingContacts ? '#2a3942' : themeGradient, border: 'none', borderRadius: 8, color: 'white', cursor: syncingContacts ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', opacity: syncingContacts ? 0.7 : 1 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                {syncingContacts ? 'Syncing…' : 'Sync Phone Contacts'}
              </button>
              {syncMsg && <span style={{ color: syncMsg.includes('Found') ? themeColor : '#8696a0', fontSize: 12 }}>{syncMsg}</span>}
            </div>
            <div style={{ padding: '10px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Recent Calls</div>
                <button onClick={fetchCallLogs} style={{ background: 'none', border: 'none', color: themeColor, cursor: 'pointer', fontSize: 12, padding: 0 }}>↻ Refresh</button>
              </div>
              {callLogs.length === 0 ? (
                <div style={{ color: '#8696a0', fontSize: 13, textAlign: 'center', padding: '32px 0' }}>
                  <div style={{ marginBottom: 8, fontSize: 32 }}>📞</div>
                  No call history yet.<br />
                  <span style={{ fontSize: 12 }}>Call history is kept for 24 hours.</span>
                </div>
              ) : callLogs.map((log) => {
                const contactInList = allContacts.find(c => c.id === log.contact_id)
                const displayName = contactInList?.name || log.contact_display_name || log.contact_username || `User ${log.contact_id}`
                const avatarUrl = contactInList?.avatar_url || log.contact_avatar_url || ''
                const initials = displayName.slice(0, 2).toUpperCase()
                const bgColor = contactInList?.color || AVATAR_COLORS[log.contact_id % AVATAR_COLORS.length]
                const isBad = log.status === 'missed' || log.status === 'rejected'
                const dirLabel = log.direction === 'outgoing' ? '↗ Outgoing' : isBad ? '↙ Missed' : '↙ Incoming'
                const durationLabel = log.duration > 0 ? ` · ${Math.floor(log.duration / 60)}:${(log.duration % 60).toString().padStart(2, '0')}` : ''
                const timeLabel = (() => {
                  try {
                    const d = new Date(log.created_at + 'Z'), now = new Date()
                    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                  } catch { return '' }
                })()
                const callContact = contactInList || { id: log.contact_id, name: displayName, initials, color: bgColor, avatar_url: avatarUrl }
                return (
                  <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: '1px solid rgba(134,150,160,0.07)' }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: bgColor, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 17, overflow: 'hidden' }}>
                        {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials}
                      </div>
                      <div style={{ position: 'absolute', bottom: 0, right: 0, width: 17, height: 17, borderRadius: '50%', background: '#1f2c34', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {log.call_type === 'video'
                          ? <svg width="10" height="10" viewBox="0 0 24 24" fill={themeColor}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                          : <svg width="10" height="10" viewBox="0 0 24 24" fill={themeColor}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                        }
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                      <div style={{ color: isBad ? '#ea5455' : '#8696a0', fontSize: 12 }}>{dirLabel}{durationLabel} · {timeLabel}</div>
                    </div>
                    <button onClick={() => { selectChat(callContact.id); initiateCall(callContact, log.call_type) }} style={{ width: 36, height: 36, background: '#2a3942', border: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: themeColor, flexShrink: 0 }}>
                      {log.call_type === 'video'
                        ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                        : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                      }
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── MAIL TAB ── */}
        {tab === 'mail' && (
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <span style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Inbox</span>
              {gmailToken && <button onClick={() => fetchEmails(gmailToken)} style={{ background: 'none', border: 'none', color: themeColor, cursor: 'pointer', fontSize: 12 }}>↻ Refresh</button>}
            </div>
            {!gmailToken ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
                <div style={{ width: 60, height: 60, background: 'rgba(66,133,244,0.12)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#4285f4" strokeWidth="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                </div>
                {isGoogleUser() ? (
                  <>
                    <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Loading Gmail…</div>
                    <div style={{ width: 24, height: 24, border: '2px solid rgba(66,133,244,0.3)', borderTopColor: '#4285f4', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '8px auto 0' }} />
                    {mailError && <div style={{ color: '#ea5455', fontSize: 12, marginTop: 12 }}>{mailError}</div>}
                  </>
                ) : (
                  <>
                    <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Connect Gmail</div>
                    <div style={{ color: '#8696a0', fontSize: 12, marginBottom: 18, lineHeight: 1.5 }}>View your Gmail inbox directly in SPVB.</div>
                    {mailError && <div style={{ color: '#ea5455', fontSize: 12, marginBottom: 12 }}>{mailError}</div>}
                    <button onClick={connectGmail} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: '#4285f4', border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13, fontFamily: 'inherit' }}>Connect with Google</button>
                  </>
                )}
              </div>
            ) : mailLoading ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
                <div style={{ width: 32, height: 32, border: '3px solid rgba(0,168,132,0.2)', borderTopColor: themeColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ color: '#8696a0', fontSize: 13 }}>Loading emails...</span>
              </div>
            ) : mailError ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
                <span style={{ color: '#ea5455', fontSize: 13 }}>{mailError}</span>
                {isGoogleUser()
                  ? <span style={{ color: '#8696a0', fontSize: 12, textAlign: 'center' }}>Please log out and sign in again with Google to restore access.</span>
                  : <button onClick={connectGmail} style={{ padding: '8px 16px', background: '#4285f4', border: 'none', borderRadius: 8, color: 'white', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Reconnect</button>
                }
              </div>
            ) : mails.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8696a0', fontSize: 13 }}>No emails found</div>
            ) : (
              <div style={{ overflowY: 'auto' }}>
                {mails.map((mail) => {
                  const avatarColors = ['#ea4335','#4285f4','#34a853','#fbbc05','#a142f4','#00a884']
                  const avatarColor = avatarColors[(mail.fromName.charCodeAt(0) || 0) % avatarColors.length]
                  return (
                    <div key={mail.id} onClick={() => openMail(mail)} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid rgba(134,150,160,0.07)', background: selectedMail?.id === mail.id ? '#2a3942' : 'transparent' }}
                      onMouseEnter={(e) => { if (selectedMail?.id !== mail.id) e.currentTarget.style.background = '#1e2d35' }}
                      onMouseLeave={(e) => { if (selectedMail?.id !== mail.id) e.currentTarget.style.background = 'transparent' }}>
                      <div style={{ width: 40, height: 40, borderRadius: '50%', background: avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 16, flexShrink: 0 }}>{mail.fromName[0]?.toUpperCase() || '?'}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                          <span style={{ color: mail.isUnread ? '#e9edef' : '#aebac1', fontSize: 13, fontWeight: mail.isUnread ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{mail.fromName}</span>
                          <span style={{ color: mail.isUnread ? themeColor : '#8696a0', fontSize: 11, flexShrink: 0 }}>{mail.date}</span>
                        </div>
                        <div style={{ color: mail.isUnread ? '#e9edef' : '#8696a0', fontSize: 12, fontWeight: mail.isUnread ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mail.subject}</div>
                        <div style={{ color: '#8696a0', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{mail.snippet}</div>
                      </div>
                      {mail.isUnread && <div style={{ width: 8, height: 8, borderRadius: '50%', background: themeColor, flexShrink: 0, marginTop: 6 }} />}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── MAIN PANEL ── */}
      <div className={`wa-main${mobileShowChat ? ' mobile-show' : ''}`} style={keyboardHeight > 0 ? { bottom: keyboardHeight } : undefined}>
        {tab === 'mail' && selectedMail ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0b141a' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(134,150,160,0.1)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <button onClick={() => setSelectedMail(null)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '6px 10px', borderRadius: 6 }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#2a3942'} onMouseLeave={(e) => e.currentTarget.style.background = 'none'}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg> Back
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
              <h2 style={{ color: '#e9edef', fontSize: 18, fontWeight: 700, marginBottom: 16, lineHeight: 1.4 }}>{selectedMail.subject}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, padding: '12px 0', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
                <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#4285f4', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 18, flexShrink: 0 }}>{selectedMail.fromName[0]?.toUpperCase()}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#e9edef', fontWeight: 600, fontSize: 14 }}>{selectedMail.fromName}</div>
                  <div style={{ color: '#8696a0', fontSize: 12 }}>{selectedMail.fromEmail}</div>
                </div>
                <div style={{ color: '#8696a0', fontSize: 12 }}>{selectedMail.date}</div>
              </div>
              {mailBodyLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#8696a0', fontSize: 13 }}>
                  <div style={{ width: 18, height: 18, border: '2px solid rgba(0,168,132,0.3)', borderTopColor: themeColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />Loading email...
                </div>
              ) : (
                <div style={{ color: '#e2e8f0', fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{selectedMail.body || selectedMail.snippet}</div>
              )}
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(134,150,160,0.1)', display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, padding: '10px 16px', background: '#2a3942', border: '1px solid rgba(134,150,160,0.15)', borderRadius: 10, color: '#8696a0', fontSize: 13 }}>Reply to this email...</div>
              <button style={{ padding: '10px 14px', background: themeGradient, border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Reply</button>
            </div>
          </div>
        ) : tab === 'mail' && !selectedMail ? (
          <div className="wa-welcome">
            <div style={{ width: 80, height: 80, background: 'rgba(66,133,244,0.1)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4285f4" strokeWidth="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            </div>
            <h2>Gmail Inbox</h2>
            <p>{gmailToken ? `${mails.length} emails loaded — select one to read` : 'Connect your Gmail to view inbox here'}</p>
            <div className="wa-lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Read-only · Emails never stored on SPVB servers</div>
          </div>
        ) : !activeId ? (
          <div className="wa-welcome">
            <div className="wa-welcome-icon" style={{ background: 'rgba(0,168,132,0.06)', border: '2px solid rgba(0,168,132,0.12)', borderRadius: '50%', overflow: 'hidden' }}>
              <img src="/spvb-logo.jpeg" alt="SPVB" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.7 }} />
            </div>
            <h2>SPVB Chat</h2>
            <p>Send and receive messages instantly.<br />All messages are end-to-end encrypted and auto-delete after 24 hours.</p>
            <div style={{ display: 'flex', gap: 20, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              {[{ icon: '💬', label: `${allContacts.filter(c => c.isSpvb).length} Contacts` }, { icon: '📞', label: 'Voice Calls' }, { icon: '📹', label: 'Video Calls' }, { icon: '🤖', label: 'AI Chatbot' }].map(({ icon, label }) => (
                <div key={label} style={{ background: '#202c33', padding: '10px 18px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 8, color: '#8696a0', fontSize: 13 }}><span>{icon}</span> {label}</div>
              ))}
            </div>
            <div className="wa-lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> End-to-end encrypted · Messages deleted after 24 hours</div>
          </div>
        ) : activeContact?.isInvite ? (
          /* Invite view */
          <div className="wa-welcome">
            <div style={{ width: 80, height: 80, borderRadius: '50%', background: '#2a3942', border: `3px dashed ${themeColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e9edef', fontWeight: 700, fontSize: 28, marginBottom: 12 }}>{activeContact.initials}</div>
            <h2>{activeContact.name}</h2>
            <p style={{ color: '#8696a0' }}>{activeContact.email}</p>
            <p>This contact is not on SPVB yet.</p>
            <button onClick={() => inviteContact(activeContact)} style={{ padding: '12px 28px', background: themeGradient, border: 'none', borderRadius: 12, color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit' }}>
              📨 Invite to SPVB
            </button>
            <button onClick={() => setActiveId(null)} style={{ marginTop: 8, padding: '8px 20px', background: 'transparent', border: '1px solid rgba(134,150,160,0.3)', borderRadius: 8, color: '#8696a0', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Back</button>
          </div>
        ) : (
          <div style={{ display: 'contents' }}>
            {/* ── MODERN CHAT LOCK OVERLAY ── */}
            {isChatLocked && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)', background: 'rgba(11,20,26,0.88)' }}>
                <style>{`
                  @keyframes lockShake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-10px)} 40%{transform:translateX(10px)} 60%{transform:translateX(-6px)} 80%{transform:translateX(6px)} }
                  @keyframes lockFadeIn { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
                `}</style>
                <div style={{ animation: 'lockFadeIn 0.35s ease', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, width: '100%', maxWidth: 340, padding: '0 24px', boxSizing: 'border-box' }}>
                  {/* Avatar */}
                  <div style={{ width: 72, height: 72, borderRadius: '50%', background: activeContact?.color || themeColor, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 28, overflow: 'hidden', border: '3px solid rgba(255,255,255,0.15)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}>
                    {activeContact?.avatar_url ? <img src={activeContact.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : activeContact?.initials}
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: '#e9edef', fontSize: 18, fontWeight: 700 }}>{activeContact?.name}</div>
                    <div style={{ color: '#8696a0', fontSize: 13, marginTop: 4 }}>This chat is locked</div>
                  </div>
                  {/* PIN dots */}
                  <div style={{ display: 'flex', gap: 16, animation: lockOverlayShake ? 'lockShake 0.5s ease' : 'none' }}>
                    {[0,1,2,3].map(i => (
                      <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: lockOverlayPinDigits.length > i ? '#e9edef' : 'transparent', border: '2px solid rgba(233,237,239,0.5)', transition: 'background 0.15s' }} />
                    ))}
                  </div>
                  {/* Numpad */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, width: '100%' }}>
                    {[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map((k, i) => {
                      if (k === '') return <div key={i} />
                      return (
                        <button key={i} onClick={() => k === '⌫' ? setLockOverlayPinDigits(p => p.slice(0,-1)) : handleLockPinDigit(String(k))}
                          style={{ height: 62, borderRadius: 14, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.07)', color: '#e9edef', fontSize: k === '⌫' ? 20 : 24, fontWeight: k === '⌫' ? 400 : 300, cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.1s', backdropFilter: 'blur(4px)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}>
                          {k}
                        </button>
                      )
                    })}
                  </div>
                  {/* Biometric button */}
                  {biometricAvail && (
                    <button onClick={handleBiometric} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 12, color: '#e9edef', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4"/></svg>
                      Use Biometrics
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Chat Header */}
            <div className="wa-chat-header">
              <div onClick={() => { setActiveId(null); setMobileShowChat(false) }} style={{ cursor: 'pointer', display: 'flex', marginRight: 4 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              </div>
              {(() => {
                const acId = String(activeContact?.id || '')
                const acHasSt = contactStatuses.some(g => String(g.userId) === acId)
                const acSeenSt = seenStatusUsers.has(acId)
                const acStGroup = acHasSt ? contactStatuses.find(g => String(g.userId) === acId) : null
                return (
                  <div
                    onClick={(e) => {
                      if (acHasSt) {
                        e.stopPropagation()
                        recordStatusView(acStGroup.statuses.map(s => s.id), acId)
                        setViewingStatusGroups([acStGroup])
                        setViewingStatusStart(0)
                      } else if (activeContact?.id !== 'bot' && !activeContact?.isInvite) {
                        setProfilePopupContact(activeContact)
                        setShowProfileImagePopup(true)
                      }
                    }}
                    title={acHasSt ? (acSeenSt ? 'Status (viewed)' : 'New status — tap to view') : 'View profile photo'}
                    style={{
                      flexShrink: 0, width: 44, height: 44, borderRadius: '50%', boxSizing: 'border-box',
                      background: acHasSt ? (acSeenSt ? 'rgba(134,150,160,0.45)' : `conic-gradient(${themeColor} 0%, #25d366 100%)`) : 'transparent',
                      padding: acHasSt ? 2 : 0,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: activeContact?.color, border: acHasSt ? '2px solid #202c33' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 600, fontSize: 15, overflow: 'hidden', boxSizing: 'border-box' }}>
                      {activeContact?.avatar_url ? <img src={activeContact.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : activeContact?.id === 'bot' ? '🤖' : activeContact?.initials}
                    </div>
                  </div>
                )
              })()}
              <div className="wa-chat-header-info" style={{ flex: 1, minWidth: 0, cursor: activeContact?.id !== 'bot' && !activeContact?.isInvite ? 'pointer' : 'default' }} onClick={() => { if (activeContact?.id !== 'bot' && !activeContact?.isInvite) setShowContactInfo(true) }}>
                <div className="name">{activeContact?.name}</div>
                {activeContact?.nickname && activeContact.nickname !== activeContact?.realName && (
                  <div style={{ color: '#8696a0', fontSize: 11 }}>{activeContact.realName}</div>
                )}
                <div className="status" style={{ color: getContactStatus(activeContact).isOnline ? '#25d366' : '#8696a0' }}>{getContactStatus(activeContact).label}</div>
              </div>
              <div className="wa-header-icons">
                <button className="wa-icon-btn" title="Search in chat" onClick={() => { setChatSearchOpen(p => !p); setChatSearchQuery(''); setChatSearchIdx(0); setTimeout(() => chatSearchRef.current?.focus(), 50) }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke={chatSearchOpen ? themeColor : 'currentColor'} strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </button>
                <button className="wa-icon-btn" title="Video call" onClick={() => initiateCall(activeContact, 'video')} disabled={activeContact?.id === 'bot' || activeContact?.isInvite}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                </button>
                <button className="wa-icon-btn" title="Voice call" onClick={() => initiateCall(activeContact, 'voice')} disabled={activeContact?.id === 'bot' || activeContact?.isInvite}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                </button>
                <div style={{ position: 'relative' }}>
                  <button className="wa-icon-btn" title="More options" onClick={() => setShowHeaderMenu(p => !p)}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                  </button>
                  {showHeaderMenu && (
                    <>
                      {/* Invisible backdrop — catches outside clicks to close the menu */}
                      <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setShowHeaderMenu(false)} />
                      <div onClick={() => setShowHeaderMenu(false)} style={{ position: 'absolute', top: 38, right: 0, background: '#233138', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 200, minWidth: 200, overflow: 'hidden' }}>
                      {false && null /* nickname edit removed from header — available in Contact Info panel */}
                      <button onClick={() => setShowChatThemeModal(true)} style={{ width: '100%', padding: '12px 16px', background: 'none', border: 'none', color: '#e9edef', fontSize: 14, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10 }} onMouseEnter={(e) => e.currentTarget.style.background = '#2a3942'} onMouseLeave={(e) => e.currentTarget.style.background = 'none'}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
                        Chat Theme
                      </button>
                      {isGroupChat && (() => {
                        const gId = parseInt(activeId?.slice(2) || '0')
                        const isCreator = activeContact?.members?.find(m => m.id === user?.id)?.is_admin
                        if (!isCreator) return null
                        const adminOnly = groupAdminOnly[gId] || false
                        return (
                          <button onClick={() => { setGroupAdminOnly(prev => ({ ...prev, [gId]: !adminOnly })); setShowHeaderMenu(false) }} style={{ width: '100%', padding: '12px 16px', background: 'none', border: 'none', color: adminOnly ? themeColor : '#e9edef', fontSize: 14, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10 }} onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={adminOnly ? themeColor : '#8696a0'} strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            {adminOnly ? '✓ Admin-only Messages' : 'Admin-only Messages'}
                          </button>
                        )
                      })()}
                      {!isGroupChat && activeContact?.id !== 'bot' && (
                        <button onClick={() => openLockModal(activeContact?.id, lockedChats.has(String(activeContact?.id)) ? 'remove' : 'set')} style={{ width: '100%', padding: '12px 16px', background: 'none', border: 'none', color: '#e9edef', fontSize: 14, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10 }} onMouseEnter={(e) => e.currentTarget.style.background = '#2a3942'} onMouseLeave={(e) => e.currentTarget.style.background = 'none'}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                          {lockedChats.has(String(activeContact?.id)) ? 'Remove Lock' : 'Lock Chat'}
                        </button>
                      )}
                      {!isGroupChat && activeContact?.id !== 'bot' && (
                        <button onClick={() => setShowContactInfo(true)} style={{ width: '100%', padding: '12px 16px', background: 'none', border: 'none', color: '#e9edef', fontSize: 14, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10 }} onMouseEnter={(e) => e.currentTarget.style.background = '#2a3942'} onMouseLeave={(e) => e.currentTarget.style.background = 'none'}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                          View Contact
                        </button>
                      )}
                      <button onClick={() => { setShowHeaderMenu(false); setShowWallpaperModal(true) }} style={{ width: '100%', padding: '12px 16px', background: 'none', border: 'none', color: '#e9edef', fontSize: 14, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10 }} onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                        Wallpaper
                      </button>
                      {activeContact?.id !== 'bot' && (
                        <div style={{ padding: '8px 16px 4px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div style={{ color: '#8696a0', fontSize: 11, textTransform: 'uppercase' }}>Disappearing Messages</div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {[{ v: null, l: 'Off' }, { v: 24, l: '24h' }, { v: 168, l: '7d' }, { v: 2160, l: '90d' }].map(({ v, l }) => {
                              const cur = chatAutoDelete[String(activeId)]
                              const isActive = v === null ? !cur : cur === v
                              return <button key={l} onClick={() => { setChatAutoDeleteTimer(activeId, v); setShowHeaderMenu(false) }} style={{ padding: '4px 10px', background: isActive ? themeGradient : '#2a3942', border: 'none', borderRadius: 6, color: isActive ? '#fff' : '#8696a0', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>{l}</button>
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* In-chat search bar (#12) */}
            {chatSearchOpen && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.12)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input ref={chatSearchRef} type="text" value={chatSearchQuery} onChange={e => { setChatSearchQuery(e.target.value); setChatSearchIdx(0) }} placeholder="Search in conversation…" style={{ flex: 1, background: 'none', border: 'none', color: '#e9edef', fontSize: 14, outline: 'none', fontFamily: 'inherit' }} />
                {chatSearchQuery && (() => {
                  const matches = chatMsgs.filter(m => m.text && String(m.text).toLowerCase().includes(chatSearchQuery.toLowerCase())).length
                  return <span style={{ color: '#8696a0', fontSize: 12, whiteSpace: 'nowrap' }}>{matches} result{matches !== 1 ? 's' : ''}</span>
                })()}
                <button onClick={() => { setChatSearchOpen(false); setChatSearchQuery('') }} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 4 }}>✕</button>
              </div>
            )}

            {/* Save / Block Banner for unknown contacts */}
            {activeContact?.isSpvb && !activeContact?.isSaved && (
              <div style={{ background: '#1a2730', borderBottom: '1px solid rgba(134,150,160,0.15)', padding: '10px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8696a0', fontWeight: 700, fontSize: 15, flexShrink: 0 }}>?</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#e9edef', fontSize: 13, fontWeight: 500 }}>Unknown number</div>
                    <div style={{ color: '#8696a0', fontSize: 12 }}>This number is not in your contact list</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => saveContact(activeContact.id)} style={{ flex: 1, padding: '8px', background: themeGradient, border: 'none', borderRadius: 8, color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                    Add to Contacts
                  </button>
                  <button onClick={() => blockContact(activeContact.id)} style={{ flex: 1, padding: '8px', background: 'rgba(234,84,85,0.12)', border: '1px solid rgba(234,84,85,0.3)', borderRadius: 8, color: '#ea5455', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                    Block
                  </button>
                </div>
              </div>
            )}

            {/* Messages */}
            {(() => {
              const ct = getChatTheme(activeId)
              const activeChatFont = PER_CHAT_FONTS.find(f => f.id === ct.font) || PER_CHAT_FONTS[0]
              const wp = chatWallpapers[String(activeId)]
              const wpDef = WALLPAPER_PRESETS.find(w => w.id === wp)
              const wpStyle = wp && (wp.startsWith('data:') || wp.startsWith('http') || wp.startsWith('/uploads/'))
                ? { backgroundImage: `url(${wp})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                : wpDef && wpDef.bg ? { backgroundImage: wpDef.bg, backgroundSize: wpDef.bgSize || 'auto' } : {}
              return (
            <div className="wa-messages" onClick={() => setMsgMenuId(null)} style={{ ...(ct.bg ? { background: ct.bg } : {}), ...(activeChatFont.font !== 'inherit' ? { fontFamily: activeChatFont.font } : {}), ...(activeChatFont.size ? { fontSize: activeChatFont.size } : {}), ...wpStyle }}>
              {chatMsgs.length === 0 && isGroupChat && (
                <div className="wa-full-row" style={{ textAlign: 'center', padding: '40px 20px', color: '#8696a0', fontSize: 13 }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
                  Group created! Say hello to the group.
                </div>
              )}
              {chatMsgs.length === 0 && activeId !== 'bot' && !isGroupChat && (
                <div className="wa-full-row" style={{ textAlign: 'center', padding: '40px 20px', color: '#8696a0', fontSize: 13 }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>👋</div>
                  Say hi to {activeContact?.name}!
                </div>
              )}
              {(chatSearchQuery ? chatMsgs.filter(m => m.text && String(m.text).toLowerCase().includes(chatSearchQuery.toLowerCase())) : chatMsgs).map((m, _msgIdx) => {
                const _nowD = new Date()
                const _getMsgDateKey = (iso) => { if (!iso) return _nowD.toDateString(); const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z'); return d.toDateString() }
                const _getMsgDateLabel = (iso) => { if (!iso) return 'Today'; const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z'); if (d.toDateString() === _nowD.toDateString()) return 'Today'; const diff = Math.floor((_nowD - d) / 86400000); if (diff === 1) return 'Yesterday'; if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' }); return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== _nowD.getFullYear() ? 'numeric' : undefined }) }
                const prevMsg = _msgIdx > 0 ? chatMsgs[_msgIdx - 1] : null
                const showDateDivider = _getMsgDateKey(m.created_at) !== _getMsgDateKey(prevMsg?.created_at)
                const _retDays = user?.msg_retention_days ?? 1
                const _expiresAt = m.created_at ? new Date((m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z')).getTime() + _retDays * 86400000 : null
                const _diffMs = _expiresAt ? _expiresAt - Date.now() : null
                const _expiresLabel = null
                const isStatusReaction = typeof m.text === 'string' && /^Reacted .+ to your status/.test(m.text)
                if (m._isCallLog) {
                  const isMissed = m.status === 'missed' || m.status === 'rejected'
                  const isOut = m.direction === 'outgoing'
                  const callIcon = m.call_type === 'video'
                    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                  const durLabel = m.duration > 0 ? ` · ${Math.floor(m.duration/60)}:${String(m.duration%60).padStart(2,'0')}` : ''
                  const callTimeLabel = (() => { try { const d = new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z'); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' } })()
                  return (
                    <div key={m.id} className="wa-full-row">
                      {showDateDivider && <div className="wa-date-divider"><span>{_getMsgDateLabel(m.created_at)}</span></div>}
                      <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 16px' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(134,150,160,0.12)', border: '1px solid rgba(134,150,160,0.15)', borderRadius: 12, padding: '6px 14px', color: isMissed ? '#ea5455' : '#8696a0', fontSize: 12, cursor: 'pointer' }}
                          onClick={() => activeContact && initiateCall(activeContact, m.call_type)}>
                          <span style={{ color: isMissed ? '#ea5455' : isOut ? themeColor : '#8696a0' }}>{callIcon}</span>
                          <span style={{ fontWeight: 500 }}>{isOut ? 'Outgoing' : isMissed ? 'Missed' : 'Incoming'} {m.call_type === 'video' ? 'video call' : 'call'}{durLabel}</span>
                          <span style={{ color: '#8696a0', fontSize: 11 }}>{callTimeLabel}</span>
                          <span style={{ color: themeColor, fontSize: 11, fontWeight: 600 }}>Call back</span>
                        </div>
                      </div>
                    </div>
                  )
                }
                if (isStatusReaction) {
                  return (
                    <div key={m.id} className="wa-full-row">
                      {showDateDivider && <div className="wa-date-divider"><span>{_getMsgDateLabel(m.created_at)}</span></div>}
                      <div style={{ textAlign: 'center', padding: '2px 16px' }}>
                        <span style={{ background: 'rgba(134,150,160,0.15)', color: '#8696a0', fontSize: 11, padding: '3px 10px', borderRadius: 12, fontStyle: 'italic' }}>
                          {m.sent ? 'You' : (activeContact?.name || 'Them')} {m.text}
                        </span>
                      </div>
                    </div>
                  )
                }
                return (
                <div key={m.id} style={{ display: 'contents' }}>
                  {showDateDivider && <div className="wa-date-divider"><span>{_getMsgDateLabel(m.created_at)}</span></div>}
                  {_expiresLabel && <div className="wa-full-row" style={{ fontSize: 9, color: '#f39c12', textAlign: m.sent ? 'right' : 'left', padding: '0 16px 1px', opacity: 0.8 }}>{_expiresLabel}</div>}
                <div id={`msg-${m.id}`} className={`wa-msg ${m.sent ? 'sent' : 'recv'}`}
                  onMouseEnter={() => setHoveredMsgId(m.id)} onMouseLeave={() => setHoveredMsgId(null)}
                  style={{ position: 'relative', transform: `translateX(${swipeState[m.id] || 0}px)`, transition: swipeState[m.id] ? 'none' : 'transform 0.2s ease' }}
                  onMouseDown={() => {
                    if (isMobile()) return
                  }}
                  onTouchStart={(e) => {
                    swipeStartX.current = e.touches[0].clientX
                    swipeStartY.current = e.touches[0].clientY
                    longPressTimer.current = setTimeout(() => {
                      longPressTimer.current = null
                      setMobileMsgMenu(m)
                    }, 500)
                  }}
                  onTouchMove={(e) => {
                    const dx = e.touches[0].clientX - swipeStartX.current
                    const dy = e.touches[0].clientY - swipeStartY.current
                    if (Math.abs(dy) > Math.abs(dx)) {
                      clearTimeout(longPressTimer.current); longPressTimer.current = null; return
                    }
                    if (Math.abs(dx) > 8) {
                      clearTimeout(longPressTimer.current); longPressTimer.current = null
                    }
                    // Swipe right (recv) or left (sent) to trigger reply
                    const allowSwipe = (m.sent && dx < 0) || (!m.sent && dx > 0)
                    if (allowSwipe) {
                      const clamped = m.sent ? Math.max(-72, Math.min(0, dx)) : Math.max(0, Math.min(72, dx))
                      setSwipeState(prev => ({ ...prev, [m.id]: clamped }))
                    }
                  }}
                  onTouchEnd={() => {
                    clearTimeout(longPressTimer.current); longPressTimer.current = null
                    const sx = swipeState[m.id] || 0
                    if (Math.abs(sx) >= 48) {
                      setReplyTo({ id: m.id, text: m.text, sent: m.sent, media_url: m.media_url, media_type: m.media_type, fileName: m.fileName })
                      setTimeout(() => inputRef.current?.focus(), 50)
                    }
                    setSwipeState(prev => ({ ...prev, [m.id]: 0 }))
                  }}>
                  {/* Swipe reply arrow indicator */}
                  {Math.abs(swipeState[m.id] || 0) > 10 && (
                    <div style={{ position: 'absolute', [m.sent ? 'right' : 'left']: -36, top: '50%', transform: 'translateY(-50%)', opacity: Math.min(1, Math.abs(swipeState[m.id] || 0) / 48), color: '#00a884', transition: 'opacity 0.1s' }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
                    </div>
                  )}
                  {/* Chevron — desktop only, outside the bubble */}
                  {!isMobile() && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      const rect = e.currentTarget.closest(`#msg-${m.id}`)?.getBoundingClientRect() || e.currentTarget.getBoundingClientRect()
                      const dropW = 180
                      const x = m.sent ? Math.max(4, rect.right - dropW) : rect.left
                      const y = rect.bottom + 4
                      const clampedY = y + 200 > window.innerHeight ? rect.top - 168 : y
                      setMsgMenuPos({ x, y: clampedY })
                      setMsgMenuId(prev => prev === m.id ? null : m.id)
                    }}
                    style={{
                      position: 'absolute', top: 4,
                      [m.sent ? 'left' : 'right']: -28, // outside the bubble
                      background: 'rgba(0,0,0,0.35)',
                      backdropFilter: 'blur(4px)', border: 'none', borderRadius: '50%',
                      width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', color: '#e9edef', zIndex: 10, padding: 0,
                      opacity: hoveredMsgId === m.id ? 1 : 0,
                      transition: 'opacity 0.15s',
                    }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                  </button>
                  )}
                  <div className="wa-bubble" style={m.sent ? { background: getChatTheme(activeId).bubble || dm.bubble_sent } : { background: getChatTheme(activeId).recvBubble || dm.bubble_recv }}>
                    {/* Group sender name */}
                    {isGroupChat && !m.sent && (
                      <div style={{ color: AVATAR_COLORS[(m.from_user_id || 0) % AVATAR_COLORS.length], fontSize: 11, fontWeight: 700, marginBottom: 3 }}>{m.sender_name || 'Unknown'}</div>
                    )}
                    {/* Quoted reply preview */}
                    {m.replyTo && (
                      <div onClick={() => { const el = document.getElementById(`msg-${m.replyTo.id}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = `2px solid ${themeColor}`; setTimeout(() => { el.style.outline = '' }, 1200) } }}
                        style={{ borderLeft: `3px solid ${m.sent ? 'rgba(255,255,255,0.45)' : themeColor}`, background: 'rgba(0,0,0,0.18)', padding: '5px 8px', borderRadius: '0 6px 6px 0', marginBottom: 6, cursor: 'pointer', minWidth: 0, maxWidth: 260 }}>
                        <div style={{ color: m.sent ? 'rgba(255,255,255,0.75)' : themeColor, fontSize: 11, fontWeight: 700, marginBottom: 2 }}>
                          {m.replyTo.sent ? 'You' : (activeContact?.name || 'Them')}
                        </div>
                        {m.replyTo.media_url ? (
                          <div style={{ color: '#a0aab4', fontSize: 11 }}>
                            {m.replyTo.media_type === 'image' ? '📷 Photo' : m.replyTo.media_type === 'video' ? '🎬 Video' : m.replyTo.media_type === 'audio' ? '🎤 Voice message' : `📄 ${m.replyTo.fileName || 'Document'}`}
                          </div>
                        ) : parseSpecialContent(m.replyTo.text)?.type === 'location' ? (
                          <div style={{ color: '#a0aab4', fontSize: 11 }}>📍 {parseSpecialContent(m.replyTo.text).name}</div>
                        ) : parseSpecialContent(m.replyTo.text)?.type === 'contact' ? (
                          <div style={{ color: '#a0aab4', fontSize: 11 }}>👤 {parseSpecialContent(m.replyTo.text).name}</div>
                        ) : parseSpecialContent(m.replyTo.text)?.type === 'gif' ? (
                          <div style={{ color: '#a0aab4', fontSize: 11 }}>🎬 GIF</div>
                        ) : (
                          <div style={{ color: '#a0aab4', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.replyTo.text}</div>
                        )}
                      </div>
                    )}
                    {/* Document / PDF bubble */}
                    {m.media_url && m.media_type === 'document' && (() => {
                      const isPdf = (m.fileName || '').toLowerCase().endsWith('.pdf') || m.media_url.includes('.pdf')
                      return (
                        <div style={{ minWidth: 220, maxWidth: 300 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px 8px' }}>
                            <div style={{ width: 42, height: 46, background: isPdf ? 'rgba(231,76,60,0.18)' : 'rgba(255,255,255,0.08)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{isPdf ? '📕' : '📄'}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ color: '#e9edef', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.fileName || 'Document'}</div>
                              <div style={{ color: '#8696a0', fontSize: 11, marginTop: 2 }}>{isPdf ? 'PDF Document' : 'Document'}</div>
                            </div>
                            <a href={m.media_url} download={m.fileName || 'document'} target="_blank" rel="noreferrer" style={{ color: themeColor, flexShrink: 0, display: 'flex' }}>
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            </a>
                          </div>
                          {isPdf && (
                            <div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
                              <iframe src={`${m.media_url}#toolbar=0&navpanes=0`} title={m.fileName} width="100%" height="200" style={{ display: 'block', border: 'none', background: '#fff' }} />
                              <a href={m.media_url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px', background: 'rgba(255,255,255,0.05)', color: themeColor, fontSize: 12, textDecoration: 'none', fontWeight: 500 }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                Open full PDF
                              </a>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                    {/* Image */}
                    {m.media_url && m.media_type === 'image' && (
                      m._viewOnce && !m.sent && viewedOnceIds.has(String(m.id)) ? (
                        <div style={{ padding: '16px', background: 'rgba(134,150,160,0.1)', borderRadius: 8, textAlign: 'center', color: '#8696a0', fontSize: 13 }}>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display: 'block', margin: '0 auto 6px' }}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                          Opened
                        </div>
                      ) : (
                        <div style={{ position: 'relative', display: 'block', maxWidth: 260, width: '100%' }}>
                          <img src={m.media_url} alt="media" style={{ width: '100%', maxWidth: 260, maxHeight: 260, objectFit: 'cover', borderRadius: 8, display: 'block', marginBottom: m.text ? 6 : 0, cursor: 'pointer' }} onClick={() => {
                            if (m._viewOnce && !m.sent) {
                              setViewedOnceIds(prev => { const n = new Set(prev); n.add(String(m.id)); try { localStorage.setItem('viewedOnce', JSON.stringify([...n])) } catch {} return n })
                            }
                            window.open(m.media_url, '_blank')
                          }} />
                          {m._viewOnce && !m.sent && <div style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.6)', borderRadius: 12, padding: '2px 8px', color: '#fff', fontSize: 11 }}>View once</div>}
                        </div>
                      )
                    )}
                    {/* Video */}
                    {m.media_url && m.media_type === 'video' && (
                      <video src={m.media_url} controls style={{ width: '100%', maxWidth: 260, maxHeight: 260, borderRadius: 8, display: 'block', marginBottom: m.text ? 6 : 0 }} />
                    )}
                    {/* Audio / Voice message */}
                    {m.media_url && m.media_type === 'audio' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', minWidth: 220 }}>
                        <div onClick={() => {
                          if (playingAudioId === m._id) {
                            // Pause
                            if (currentAudioRef.current) { try { currentAudioRef.current.pause() } catch {} }
                            setPlayingAudioId(null)
                          } else {
                            // Stop any currently playing audio
                            if (currentAudioRef.current) { try { currentAudioRef.current.pause(); currentAudioRef.current.currentTime = 0 } catch {} }
                            const a = new Audio(m.media_url)
                            currentAudioRef.current = a
                            a.volume = 1
                            a.onended = () => { currentAudioRef.current = null; setPlayingAudioId(null) }
                            a.onerror = () => { currentAudioRef.current = null; setPlayingAudioId(null) }
                            a.play().catch(() => { currentAudioRef.current = null; setPlayingAudioId(null) })
                            setPlayingAudioId(m._id)
                          }
                        }} style={{ width: 42, height: 42, borderRadius: '50%', background: m.sent ? 'rgba(255,255,255,0.18)' : themeGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }}>
                          {playingAudioId === m._id
                            ? <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                            : <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                          }
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ height: 24, display: 'flex', alignItems: 'center', gap: 2 }}>
                            {[3,5,8,5,9,6,4,7,5,8,4,6,3,7,5].map((h, i) => (
                              <div key={i} style={{ width: 3, height: h * 2, borderRadius: 2, background: playingAudioId === m._id ? themeColor : 'rgba(134,150,160,0.6)', transition: 'background 0.2s' }} />
                            ))}
                          </div>
                          <div style={{ color: '#8696a0', fontSize: 10, marginTop: 2 }}>Voice message</div>
                        </div>
                      </div>
                    )}
                    {/* Location bubble */}
                    {(() => {
                      const sp = parseSpecialContent(m.text)
                      if (!sp || sp.type !== 'location') return null
                      const mapsUrl = `https://www.google.com/maps?q=${sp.lat},${sp.lng}`
                      return (
                        <a href={mapsUrl} target="_blank" rel="noreferrer" style={{ display: 'block', textDecoration: 'none', borderRadius: 10, overflow: 'hidden', width: '100%', maxWidth: 240, marginBottom: 2 }}>
                          <div style={{ background: '#1a3a2a', height: 120, position: 'relative', overflow: 'hidden' }}>
                            {/* Map grid lines */}
                            <svg width="100%" height="100%" style={{ position: 'absolute', top: 0, left: 0, opacity: 0.25 }}>
                              {[20,40,60,80,100].map(y => <line key={y} x1="0" y1={`${y}%`} x2="100%" y2={`${y}%`} stroke="#25d366" strokeWidth="1"/>)}
                              {[16,32,48,64,80].map(x => <line key={x} x1={`${x}%`} y1="0" x2={`${x}%`} y2="100%" stroke="#25d366" strokeWidth="1"/>)}
                              <ellipse cx="50%" cy="50%" rx="40%" ry="30%" stroke="#25d366" strokeWidth="1" fill="none" strokeDasharray="4 3"/>
                            </svg>
                            {/* Pin icon */}
                            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -65%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                              <div style={{ width: 28, height: 28, borderRadius: '50% 50% 50% 0', background: '#ea4335', transform: 'rotate(-45deg)', border: '3px solid white', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }} />
                            </div>
                          </div>
                          <div style={{ background: 'rgba(0,0,0,0.3)', padding: '8px 10px' }}>
                            <div style={{ color: '#e9edef', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>📍 {sp.name}</div>
                            <div style={{ color: '#25d366', fontSize: 11 }}>Tap to view on Maps</div>
                          </div>
                        </a>
                      )
                    })()}
                    {/* Contact bubble */}
                    {(() => {
                      const sp = parseSpecialContent(m.text)
                      if (!sp || sp.type !== 'contact') return null
                      const initial = (sp.name || '?')[0].toUpperCase()
                      const colors = ['#25d366','#128c7e','#f39c12','#8e44ad','#2980b9','#e74c3c']
                      const avatarColor = colors[initial.charCodeAt(0) % colors.length]
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 4px', minWidth: 200 }}>
                          <div style={{ width: 46, height: 46, borderRadius: '50%', background: avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 20, flexShrink: 0 }}>{initial}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sp.name}</div>
                            {sp.phone && <div style={{ color: '#8696a0', fontSize: 12, marginTop: 1 }}>{sp.phone}</div>}
                            {sp.email && <div style={{ color: '#8696a0', fontSize: 11, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sp.email}</div>}
                          </div>
                          <div style={{ flexShrink: 0 }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                          </div>
                        </div>
                      )
                    })()}
                    {/* GIF bubble */}
                    {(() => {
                      const sp = parseSpecialContent(m.text)
                      if (!sp || sp.type !== 'gif') return null
                      return <img src={sp.url} alt="GIF" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, display: 'block' }} />
                    })()}
                    {/* Forward count badge (#17) */}
                    {forwardCounts[String(m.id)] > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#8696a0', fontSize: 11, marginBottom: 2 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
                        Forwarded {forwardCounts[String(m.id)] > 1 ? `${forwardCounts[String(m.id)]} times` : ''}
                      </div>
                    )}
                    {/* Poll rendering (#7) */}
                    {(() => {
                      if (!m.text || !String(m.text).startsWith('__poll__|')) return null
                      const parts = m.text.split('|')
                      const question = parts[1] || ''
                      const opts = parts.slice(2).join('|').split('||').filter(Boolean)
                      const poll = activePolls[String(m.id)] || { votes: {} }
                      const totalVotes = Object.values(poll.votes || {}).flat().length
                      return (
                        <div style={{ minWidth: 200 }}>
                          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>{question}</div>
                          {opts.map((opt, idx) => {
                            const votes = (poll.votes[idx] || []).length
                            const pct = totalVotes > 0 ? Math.round(votes / totalVotes * 100) : 0
                            return (
                              <button key={idx} onClick={() => {
                                const myId = String(user?.id)
                                setActivePolls(prev => {
                                  const p = prev[String(m.id)] || { votes: {} }
                                  const newVotes = { ...p.votes }
                                  // Remove from other options
                                  Object.keys(newVotes).forEach(k => { newVotes[k] = (newVotes[k] || []).filter(id => id !== myId) })
                                  newVotes[idx] = [...(newVotes[idx] || []), myId]
                                  return { ...prev, [String(m.id)]: { ...p, votes: newVotes } }
                                })
                              }} style={{ width: '100%', marginBottom: 6, background: 'none', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', textAlign: 'left', position: 'relative', overflow: 'hidden' }}>
                                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: 'rgba(0,168,132,0.15)', transition: 'width 0.3s' }} />
                                <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', color: '#e9edef', fontSize: 13 }}>
                                  <span>{opt}</span>
                                  <span style={{ color: '#8696a0' }}>{pct}%</span>
                                </div>
                              </button>
                            )
                          })}
                          <div style={{ color: '#8696a0', fontSize: 11, marginTop: 4 }}>{totalVotes} vote{totalVotes !== 1 ? 's' : ''}</div>
                        </div>
                      )
                    })()}
                    {/* View-once media marker */}
                    {m._viewOnce && viewedOnceIds.has(String(m.id)) && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#8696a0', fontSize: 12, fontStyle: 'italic', padding: '8px 0' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        Photo opened
                      </div>
                    )}
                    {m.text && !parseSpecialContent(m.text) && !String(m.text).startsWith('__poll__|') && (
                      (String(m.text).startsWith('__e2e__|') || String(m.text).startsWith('__e2ev2__|') || String(m.text).startsWith('e2e__|'))
                        ? (
                          decryptGaveUp
                            ? (
                              <div className="wa-bubble-text" style={{ color: '#8696a0', fontSize: 12, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 5 }}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                <span>Message from before encryption upgrade</span>
                              </div>
                            ) : (
                              <div className="wa-bubble-text" style={{ color: '#8696a0', fontSize: 12, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 11, height: 11, border: '2px solid #8696a066', borderTopColor: '#8696a0', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                                <span>Decrypting…</span>
                              </div>
                            )
                        )
                        : <div className="wa-bubble-text">{linkifyText(m.text)}</div>
                    )}
                    {!m.text && !m.media_url && <div className="wa-bubble-text"></div>}
                    <div className="wa-bubble-meta">
                      <span className="wa-bubble-time">{m.time}</span>
                      {m.sent && (() => {
                        // pending = clock (not sent yet)
                        if (m.pending) return <span className="wa-tick unread"><svg viewBox="0 0 10 11" fill="currentColor" width="10" height="11"><path d="M9.394.566a.579.579 0 0 0-.817 0L3.5 5.643 1.423 3.567a.579.579 0 0 0-.817.817l2.486 2.486a.578.578 0 0 0 .817 0l5.485-5.487a.578.578 0 0 0 0-.817z"/></svg></span>
                        // seen = double blue ticks
                        if (m.read || m.status === 'seen') return <span className="wa-tick"><svg viewBox="0 0 18 11" fill="currentColor"><path d="M17.394.566a.579.579 0 0 0-.817 0l-9.43 9.39-4.33-4.356a.579.579 0 0 0-.817.817l4.74 4.771a.578.578 0 0 0 .817 0l9.84-9.8a.578.578 0 0 0 0-.822z"/><path d="M11.394.566a.579.579 0 0 0-.817 0l-5.43 5.39.817.817 5.43-5.39a.578.578 0 0 0 0-.817z"/></svg></span>
                        // delivered = double grey ticks
                        if (m.status === 'delivered') return <span className="wa-tick unread"><svg viewBox="0 0 18 11" fill="currentColor"><path d="M17.394.566a.579.579 0 0 0-.817 0l-9.43 9.39-4.33-4.356a.579.579 0 0 0-.817.817l4.74 4.771a.578.578 0 0 0 .817 0l9.84-9.8a.578.578 0 0 0 0-.822z"/><path d="M11.394.566a.579.579 0 0 0-.817 0l-5.43 5.39.817.817 5.43-5.39a.578.578 0 0 0 0-.817z"/></svg></span>
                        // sent = single grey tick
                        return <span className="wa-tick unread"><svg viewBox="0 0 10 11" fill="currentColor" width="10" height="11"><path d="M9.394.566a.579.579 0 0 0-.817 0L3.5 5.643 1.423 3.567a.579.579 0 0 0-.817.817l2.486 2.486a.578.578 0 0 0 .817 0l5.485-5.487a.578.578 0 0 0 0-.817z"/></svg></span>
                      })()}
                    </div>
                  </div>
                </div>
                </div>
                )
              })}
              {botTyping && activeId === 'bot' && <div className="wa-msg recv"><div className="wa-typing"><span /><span /><span /></div></div>}
              {activeId && activeId !== 'bot' && typingUsers[String(activeId)] && (
                <div className="wa-msg recv">
                  <div className="wa-bubble recv" style={{ background: darkMode ? '#202c33' : '#fff', display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px' }}>
                    <div className="wa-typing"><span /><span /><span /></div>
                    <span style={{ color: darkMode ? '#8696a0' : '#667781', fontSize: 12 }}>typing...</span>
                  </div>
                </div>
              )}
              <div ref={msgEndRef} />
            </div>
            )})()}

            {/* Bot smart quick replies */}
            {activeId === 'bot' && !botTyping && botQuickReplies.length > 0 && (
              <div className="wa-quick-replies">
                {botQuickReplies.map((qr) => (
                  <button key={qr} className="wa-quick-reply-btn" style={{ borderColor: `${themeColor}55`, color: themeColor }}
                    onClick={() => {
                      setBotQuickReplies([])
                      const msg = { id: nextBotId(), text: qr, sent: true, time: nowTime(), read: true }
                      setBotMsgs(prev => [...prev, msg])
                      setBotTyping(true)
                      setTimeout(() => {
                        const reply = getBotReply(qr)
                        setBotMsgs(prev => [...prev, { id: nextBotId(), text: reply, sent: false, time: nowTime(), read: true }])
                        setBotTyping(false)
                        fetchSmartReplies(reply)
                      }, 600 + Math.random() * 700)
                    }}>
                    {qr}
                  </button>
                ))}
              </div>
            )}

            {/* Reply preview bar */}
            {replyTo && (
              <div style={{ padding: '8px 16px', background: '#1a2530', borderTop: '1px solid rgba(134,150,160,0.1)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2.5" style={{ flexShrink: 0 }}><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
                <div style={{ borderLeft: `3px solid ${themeColor}`, paddingLeft: 10, flex: 1, minWidth: 0 }}>
                  <div style={{ color: themeColor, fontSize: 12, fontWeight: 700, marginBottom: 2 }}>
                    {replyTo.sent ? 'You' : (activeContact?.name || 'Them')}
                  </div>
                  {replyTo.media_url ? (
                    <div style={{ color: '#8696a0', fontSize: 12 }}>
                      {replyTo.media_type === 'image' ? '📷 Photo' : replyTo.media_type === 'video' ? '🎬 Video' : replyTo.media_type === 'audio' ? '🎤 Voice message' : `📄 ${replyTo.fileName || 'Document'}`}
                    </div>
                  ) : parseSpecialContent(replyTo.text)?.type === 'location' ? (
                    <div style={{ color: '#8696a0', fontSize: 12 }}>📍 {parseSpecialContent(replyTo.text).name}</div>
                  ) : parseSpecialContent(replyTo.text)?.type === 'contact' ? (
                    <div style={{ color: '#8696a0', fontSize: 12 }}>👤 {parseSpecialContent(replyTo.text).name}</div>
                  ) : (
                    <div style={{ color: '#8696a0', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyTo.text}</div>
                  )}
                </div>
                <button onClick={() => setReplyTo(null)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}>×</button>
              </div>
            )}

            <div className="wa-input-bar">
              {/* Hidden file inputs — always rendered */}
              <input ref={mediaInputRef} type="file" accept="image/*,video/*" style={{ display: 'none' }} onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = ''
                if (!f) return
                if (activeId === 'bot') { sendBotMedia(f); return }
                if (f.type.startsWith('image/')) {
                  // Show crop modal first, then open send preview with cropped image
                  const objUrl = URL.createObjectURL(f)
                  setCropSrc(objUrl)
                  setCropCallback(() => (blob) => {
                    URL.revokeObjectURL(objUrl)
                    setCropSrc(null); setCropCallback(null)
                    const cropped = Object.assign(new File([blob], f.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }), { _spvbCropped: true })
                    setPendingMediaFile({ file: cropped, previewUrl: URL.createObjectURL(blob), isImage: true })
                    setPendingMediaViewOnce(false)
                  })
                } else {
                  setPendingMediaFile({ file: f, previewUrl: URL.createObjectURL(f), isImage: false })
                  setPendingMediaViewOnce(false)
                }
              }} />
              <input ref={docInputRef} type="file" accept=".pdf,.doc,.docx,.txt,.xlsx,.xls,.pptx,.ppt,.zip,.rar,.csv,audio/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { activeId === 'bot' ? sendBotMedia(f) : sendMedia(f) }; e.target.value = '' }} />
              <input ref={cameraInputRef} type="file" accept="image/*" capture="camera" style={{ display: 'none' }} onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = ''
                if (!f) return
                if (activeId === 'bot') { sendBotMedia(f); return }
                const objUrl = URL.createObjectURL(f)
                setCropSrc(objUrl)
                setCropCallback(() => (blob) => {
                  URL.revokeObjectURL(objUrl)
                  setCropSrc(null); setCropCallback(null)
                  setPendingMediaFile({ file: new File([blob], f.name, { type: 'image/jpeg' }), previewUrl: URL.createObjectURL(blob), isImage: true })
                  setPendingMediaViewOnce(false)
                })
              }} />

              {isRecording ? (
                /* ── Recording mode ── */
                <>
                  <button onClick={cancelRecording} title="Cancel" style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(234,84,85,0.15)', border: '1px solid rgba(234,84,85,0.35)', color: '#ea5455', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                  </button>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, background: '#2a3942', borderRadius: 24, padding: '0 14px', height: 46 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ea5455', animation: 'recPulse 1s ease-in-out infinite', flexShrink: 0 }} />
                    <span style={{ color: '#ea5455', fontSize: 13, fontWeight: 600, flexShrink: 0, minWidth: 34 }}>{formatRecTime(recordingSeconds)}</span>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 2 }}>
                      {[...Array(18)].map((_, i) => (
                        <div key={i} style={{ width: 2.5, borderRadius: 2, background: themeColor, opacity: 0.7, height: `${6 + ((i * 7 + recordingSeconds * 3) % 18)}px`, transition: 'height 0.3s' }} />
                      ))}
                    </div>
                  </div>
                  <button onClick={stopAndSendRecording} title="Send" style={{ width: 46, height: 46, borderRadius: '50%', background: themeGradient, border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: `0 2px 12px ${themeColor}66` }}>
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
                  </button>
                </>
              ) : (
                /* ── Normal input mode ── */
                <>
                  <button className="wa-icon-btn" onClick={() => { setShowEmoji(!showEmoji); setShowAttachMenu(false) }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 24, height: 24 }}><circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                  </button>
                  {/* WhatsApp-style attach — fixed bottom sheet (works on mobile without clipping) */}
                  {showAttachMenu && (
                    <div style={{ position: 'fixed', inset: 0, zIndex: 400 }} onClick={() => setShowAttachMenu(false)}>
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: '#1e2d35', borderRadius: '20px 20px 0 0', boxShadow: '0 -8px 32px rgba(0,0,0,0.5)', padding: '16px 16px max(20px, env(safe-area-inset-bottom))' }}
                        onClick={e => e.stopPropagation()}>
                        {/* Handle */}
                        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(134,150,160,0.3)' }} />
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '18px 8px', justifyItems: 'center', maxWidth: 400, margin: '0 auto' }}>
                          {[
                            { label: 'Camera', bg: '#0073e6', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M20 5h-3.17L15 3H9L7.17 5H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-8 13c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.65 0-3 1.35-3 3s1.35 3 3 3 3-1.35 3-3-1.35-3-3-3z"/></svg>, action: () => { setShowAttachMenu(false); cameraInputRef.current?.click() } },
                            { label: 'Photos', bg: '#bf59cf', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>, action: () => { setShowAttachMenu(false); mediaInputRef.current?.click() } },
                            { label: 'Document', bg: '#5157ae', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>, action: () => { setShowAttachMenu(false); docInputRef.current?.click() } },
                            { label: locationLoading ? 'Getting...' : 'Location', bg: '#09b83e', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>, action: shareLocation },
                            { label: 'Contact', bg: '#f39c12', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>, action: () => { setShowAttachMenu(false); setShowContactPicker(true) } },
                            { label: 'Audio', bg: '#e74c3c', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/></svg>, action: () => { setShowAttachMenu(false); startRecording() } },
                            { label: 'Broadcast', bg: '#00a884', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z"/></svg>, action: () => { setShowAttachMenu(false); setShowBroadcastModal(true) } },
                            ...(isGroupChat ? [{ label: 'Poll', bg: '#6c5ce7', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M5 9h4v11H5V9zm10-5h4v16h-4V4zm-5 7h4v9h-4v-9z"/></svg>, action: () => { setShowAttachMenu(false); setShowPollModal(true) } }] : []),
                          ].map(({ label, bg, icon, action }) => (
                            <button key={label} onClick={action}
                              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 10, width: '100%' }}
                              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'} onMouseLeave={(e) => e.currentTarget.style.background = 'none'}>
                              <div style={{ width: 52, height: 52, borderRadius: '50%', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 3px 10px ${bg}55` }}>{icon}</div>
                              <span style={{ color: '#e9edef', fontSize: 11, fontWeight: 500 }}>{label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  <button className="wa-icon-btn" title="Attach" onClick={() => { setShowAttachMenu(p => !p); setShowEmoji(false) }}
                    style={locationLoading ? { opacity: 0.6 } : {}}>
                    {locationLoading
                      ? <div style={{ width: 20, height: 20, border: '2px solid rgba(134,150,160,0.3)', borderTopColor: themeColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 24, height: 24 }}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>}
                  </button>
                  <div className="wa-input-wrap" style={{ position: 'relative' }}>
                    {/* @mention dropdown (#6) */}
                    {showMentionList && isGroupChat && (() => {
                      const members = (groupContacts.find(g => g.id === activeId)?.members || []).filter(m => m.username && m.username.toLowerCase().includes(mentionSearch.toLowerCase()))
                      return members.length > 0 ? (
                        <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, background: '#1e2b33', borderRadius: 8, boxShadow: '0 -4px 20px rgba(0,0,0,0.4)', overflow: 'hidden', zIndex: 200, border: '1px solid rgba(134,150,160,0.15)', marginBottom: 4 }}>
                          {members.slice(0, 5).map(m => (
                            <button key={m.id} onClick={() => {
                              setInput(prev => prev.replace(/@[\w]*$/, `@${m.username} `))
                              setShowMentionList(false); setMentionSearch('')
                              setTimeout(() => inputRef.current?.focus(), 50)
                            }} style={{ width: '100%', padding: '10px 14px', background: 'none', border: 'none', color: '#e9edef', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}
                              onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                              <div style={{ width: 28, height: 28, borderRadius: '50%', background: AVATAR_COLORS[(m.id || 0) % AVATAR_COLORS.length], display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 12, fontWeight: 700, flexShrink: 0, overflow: 'hidden' }}>
                                {m.avatar_url ? <img src={m.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (m.username || '?')[0].toUpperCase()}
                              </div>
                              <span>@{m.username}</span>
                            </button>
                          ))}
                        </div>
                      ) : null
                    })()}
                    <input ref={inputRef} type="text" placeholder={isGroupChat ? "Type a message, @ to mention" : "Type a message"} value={input} onChange={(e) => {
                      const val = e.target.value
                      setInput(val)
                      // @mention detection
                      const atMatch = val.match(/@([\w]*)$/)
                      if (atMatch && isGroupChat) { setMentionSearch(atMatch[1]); setShowMentionList(true) }
                      else { setShowMentionList(false); setMentionSearch('') }
                      // Send typing indicator (throttled to once per 2s)
                      if (activeId && activeId !== 'bot' && wsRef.current?.readyState === 1 && !typingThrottleRef.current) {
                        wsRef.current.send(JSON.stringify({ type: 'typing', target: String(activeId) }))
                        typingThrottleRef.current = setTimeout(() => { typingThrottleRef.current = null }, 2000)
                      }
                    }} onKeyDown={e => { if (e.key === 'Escape') { setShowMentionList(false) }; handleKey(e) }} onFocus={() => setShowAttachMenu(false)} />
                    {/* Schedule button — hidden on mobile to save space */}
                    <button className="wa-schedule-btn" title="Schedule message" onClick={() => setShowScheduler(p => !p)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: showScheduler ? themeColor : '#8696a0', display: 'flex', borderRadius: 4, flexShrink: 0 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    </button>
                  </div>
                  {/* Schedule picker — fixed so it's never clipped on mobile */}
                  {showScheduler && (
                    <div style={{ position: 'fixed', inset: 0, zIndex: 400, display: 'flex', alignItems: 'flex-end' }} onClick={() => setShowScheduler(false)}>
                      <div style={{ width: '100%', background: '#1e2d35', borderRadius: '20px 20px 0 0', padding: '20px 16px max(20px, env(safe-area-inset-bottom))', boxShadow: '0 -8px 32px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: 14 }}
                        onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
                          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(134,150,160,0.3)' }} />
                        </div>
                        <div style={{ color: '#e9edef', fontSize: 15, fontWeight: 600 }}>Schedule Message</div>
                        <input type="datetime-local" value={scheduleTime} onChange={e => setScheduleTime(e.target.value)} min={new Date().toISOString().slice(0, 16)} style={{ background: '#2a3942', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 10, padding: '10px 14px', color: '#e9edef', fontSize: 14, fontFamily: 'inherit', outline: 'none', width: '100%' }} />
                        <div style={{ display: 'flex', gap: 10 }}>
                          <button onClick={() => setShowScheduler(false)} style={{ flex: 1, padding: '12px', background: 'none', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 10, color: '#8696a0', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', fontWeight: 600 }}>Cancel</button>
                          <button onClick={scheduleMessage} disabled={!scheduleTime || !input.trim()} style={{ flex: 1, padding: '12px', background: themeGradient, border: 'none', borderRadius: 10, color: '#fff', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', fontWeight: 600, opacity: (!scheduleTime || !input.trim()) ? 0.5 : 1 }}>Schedule</button>
                        </div>
                      </div>
                    </div>
                  )}
                  <button className="wa-send-btn" onClick={() => { setShowAttachMenu(false); setShowScheduler(false); if (input.trim()) sendMessage(); else startRecording() }} style={{ background: themeGradient }}>
                    {input.trim()
                      ? <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
                      : <svg viewBox="0 0 24 24" fill="white" width="22" height="22"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/></svg>}
                  </button>
                </>
              )}
            </div>
            <style>{`@keyframes recPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.8)} }`}</style>

            {/* Emoji / Sticker / GIF picker — sits BELOW the input bar */}
            {showEmoji && (() => {
              const allEmojis = EMOJI_CATS[emojiCategory]?.emojis || []
              const filteredEmojis = emojiSearch ? EMOJI_CATS.flatMap(c => c.emojis).filter(e => e.includes(emojiSearch)) : allEmojis
              const tenorKey = import.meta.env.VITE_TENOR_API_KEY || ''
              return (
                <div style={{ background: '#202c33', borderTop: '1px solid rgba(134,150,160,0.1)', display: 'flex', flexDirection: 'column', maxHeight: 'min(300px, 40dvh)', flexShrink: 0 }}>
                  {/* Tabs row */}
                  <div style={{ display: 'flex', borderBottom: '1px solid rgba(134,150,160,0.1)', flexShrink: 0 }}>
                    {['emoji', 'sticker', 'gif'].map(t => (
                      <button key={t} onClick={() => { setEmojiTab(t); if (t === 'gif' && gifs.length === 0) searchGifs('') }} style={{ flex: 1, padding: '8px 0', background: 'none', border: 'none', color: emojiTab === t ? themeColor : '#8696a0', fontSize: 12, fontWeight: 600, cursor: 'pointer', borderBottom: emojiTab === t ? `2px solid ${themeColor}` : '2px solid transparent', fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {t === 'emoji' ? '😀' : t === 'sticker' ? '🎉' : '🎬'}
                      </button>
                    ))}
                  </div>
                  {emojiTab === 'emoji' && (
                    <>
                      <div style={{ display: 'flex', padding: '4px 8px', gap: 2, borderBottom: '1px solid rgba(134,150,160,0.08)', flexShrink: 0, overflowX: 'auto' }}>
                        {EMOJI_CATS.map((cat, i) => (
                          <button key={cat.id} onClick={() => { setEmojiCategory(i); setEmojiSearch('') }} title={cat.id} style={{ width: 32, height: 28, background: emojiCategory === i ? `${themeColor}22` : 'none', border: emojiCategory === i ? `1px solid ${themeColor}44` : '1px solid transparent', borderRadius: 6, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{cat.icon}</button>
                        ))}
                        <input value={emojiSearch} onChange={e => setEmojiSearch(e.target.value)} placeholder="Search…" style={{ flex: 1, minWidth: 60, padding: '3px 8px', background: '#2a3942', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 6, color: '#e9edef', fontSize: 12, outline: 'none', fontFamily: 'inherit' }} />
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '8px', overflowY: 'auto', flex: 1 }}>
                        {filteredEmojis.map((em, i) => (
                          <button key={`${em}-${i}`} onClick={() => setInput(p => p + em)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', padding: '4px 5px', borderRadius: 6, lineHeight: 1 }} onMouseOver={(e) => (e.currentTarget.style.background = '#2a3942')} onMouseOut={(e) => (e.currentTarget.style.background = 'none')}>{em}</button>
                        ))}
                      </div>
                    </>
                  )}
                  {emojiTab === 'sticker' && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, padding: 10, overflowY: 'auto', flex: 1 }}>
                      {['😀','🎉','🔥','💯','❤️','👍','😂','🥳','🙌','💪','🤝','🫶','✨','🎊','🥺','😎','🤗','😍','🤩','🎈','🏆','⭐','💫','🌟','🦄','🐶','🐱','🐸','🍕','🍦','🎮','📱'].map(emoji => (
                        <button key={emoji} onClick={() => { sendSpecialMsg(emoji); setShowEmoji(false) }}
                          style={{ background: '#2a3942', border: 'none', borderRadius: 10, padding: '10px 8px', cursor: 'pointer', fontSize: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, aspectRatio: '1' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#3a4a52'} onMouseLeave={e => e.currentTarget.style.background = '#2a3942'}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                  {emojiTab === 'gif' && (
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                      <div style={{ padding: '6px 8px', flexShrink: 0, display: 'flex', gap: 6 }}>
                        <input value={gifSearch} onChange={e => setGifSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchGifs(gifSearch)} placeholder="Search GIFs…" style={{ flex: 1, padding: '6px 10px', background: '#2a3942', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 6, color: '#e9edef', fontSize: 12, outline: 'none', fontFamily: 'inherit' }} />
                        <button onClick={() => searchGifs(gifSearch)} style={{ padding: '6px 12px', background: themeGradient, border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>Go</button>
                      </div>
                      {!tenorKey && <div style={{ padding: '20px', textAlign: 'center', color: '#8696a0', fontSize: 12 }}>Add VITE_TENOR_API_KEY to .env to enable GIFs</div>}
                      {gifLoading && <div style={{ padding: 20, textAlign: 'center', color: '#8696a0', fontSize: 12 }}>Loading…</div>}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, padding: '0 8px 8px', overflowY: 'auto', flex: 1 }}>
                        {gifs.map(g => {
                          const url = g.media_formats?.gif?.url || g.media_formats?.tinygif?.url || ''
                          if (!url) return null
                          return <img key={g.id} src={url} alt={g.title} onClick={() => { sendSpecialMsg(`__gif__|${url}`); setShowEmoji(false) }} style={{ width: '100%', height: 80, objectFit: 'cover', borderRadius: 6, cursor: 'pointer', display: 'block' }} />
                        })}
                      </div>
                    </div>
                  )}
                  {/* Down-arrow close bar — always at bottom of picker */}
                  <button onClick={() => setShowEmoji(false)} style={{ width: '100%', padding: '6px 0', background: 'none', border: 'none', borderTop: '1px solid rgba(134,150,160,0.08)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                </div>
              )
            })()}

            {/* Profile popup moved to root level — see below */}

            {/* Contact Info Panel — slides in from the left */}
            {showContactInfo && activeContact && activeContact.id !== 'bot' && !activeContact.isInvite && (
              <div className="contact-info-panel" style={{ position: 'absolute', top: 0, left: 0, width: 360, height: '100%', background: '#111b21', borderRight: '1px solid rgba(134,150,160,0.12)', display: 'flex', flexDirection: 'column', zIndex: 50, overflowY: 'auto', animation: 'slideInLeft 0.22s cubic-bezier(0.4,0,0.2,1)' }}>
                {/* Panel header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
                  <button onClick={() => setShowContactInfo(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 4, display: 'flex' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                  </button>
                  <span style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>Contact info</span>
                </div>
                {/* Cover photo + avatar overlay */}
                <div style={{ position: 'relative', height: 180, background: activeContact.cover_url ? 'transparent' : `linear-gradient(160deg, ${activeContact.color}99 0%, #111b21 100%)`, flexShrink: 0 }}>
                  {activeContact.cover_url && <img src={activeContact.cover_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent 40%, rgba(17,27,33,0.75) 100%)' }} />
                  <div style={{ position: 'absolute', bottom: -50, left: '50%', transform: 'translateX(-50%)', width: 100, height: 100, borderRadius: '50%', border: '4px solid #111b21', background: activeContact.color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 38, overflow: 'hidden', zIndex: 2 }}>
                    {activeContact.avatar_url ? <img src={activeContact.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : activeContact.initials}
                  </div>
                </div>
                {/* Name / status / call buttons */}
                <div style={{ background: '#202c33', padding: '62px 20px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, borderBottom: '6px solid #111b21' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: '#e9edef', fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{activeContact.name}</div>
                    {activeContact.nickname && activeContact.nickname !== activeContact.realName && (
                      <div style={{ color: '#8696a0', fontSize: 13 }}>{activeContact.realName}</div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
                      {getContactStatus(activeContact).isOnline && (
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#25d366', display: 'inline-block', flexShrink: 0 }} />
                      )}
                      <span style={{ color: getContactStatus(activeContact).isOnline ? '#25d366' : '#8696a0', fontSize: 13 }}>
                        {getContactStatus(activeContact).label}
                      </span>
                    </div>
                  </div>
                  {/* Call buttons */}
                  <div style={{ display: 'flex', gap: 24, marginTop: 8 }}>
                    <button onClick={() => { initiateCall(activeContact, 'voice'); setShowContactInfo(false) }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#8696a0' }}>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                      </div>
                      <span style={{ fontSize: 12 }}>Voice</span>
                    </button>
                    <button onClick={() => { initiateCall(activeContact, 'video'); setShowContactInfo(false) }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#8696a0' }}>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                      </div>
                      <span style={{ fontSize: 12 }}>Video</span>
                    </button>
                  </div>
                </div>
                {/* Nickname section — only in contact info panel */}
                {activeContact.isSaved && (
                  <div style={{ background: '#202c33', padding: '16px 20px', margin: '6px 0', borderTop: '1px solid rgba(134,150,160,0.08)', borderBottom: '1px solid rgba(134,150,160,0.08)' }}>
                    <div style={{ color: themeColor, fontSize: 12, fontWeight: 600, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Nickname</div>
                    {editingNickname === activeContact.id ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          autoFocus
                          value={nicknameInput}
                          onChange={(e) => setNicknameInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveNickname(activeContact.id, nicknameInput); if (e.key === 'Escape') setEditingNickname(null) }}
                          placeholder={activeContact.realName || 'Enter nickname…'}
                          maxLength={50}
                          style={{ flex: 1, padding: '8px 12px', background: '#2a3942', border: `1px solid ${themeColor}55`, borderRadius: 8, color: '#e9edef', fontSize: 14, fontFamily: 'inherit', outline: 'none' }}
                        />
                        <button onClick={() => saveNickname(activeContact.id, nicknameInput)} style={{ padding: '8px 14px', background: themeGradient, border: 'none', borderRadius: 8, color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>Save</button>
                        <button onClick={() => setEditingNickname(null)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px' }}>×</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ color: '#e9edef', fontSize: 14 }}>
                          {activeContact.nickname && activeContact.nickname !== activeContact.realName ? activeContact.nickname : <span style={{ color: '#8696a0', fontStyle: 'italic' }}>No nickname set</span>}
                        </span>
                        <button
                          onClick={() => { setEditingNickname(activeContact.id); setNicknameInput(activeContact.nickname || '') }}
                          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#2a3942', border: 'none', borderRadius: 8, color: '#e9edef', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
                          Edit
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {/* Notification Sound picker */}
                <div style={{ background: '#202c33', padding: '16px 20px', margin: '6px 0', borderTop: '1px solid rgba(134,150,160,0.08)', borderBottom: '1px solid rgba(134,150,160,0.08)' }}>
                  <div style={{ color: themeColor, fontSize: 12, fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 6 }}>
                    🔔 Notification Sound
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {RINGTONES.map(rt => {
                      const selected = (contactRingtones[String(activeContact.id)] || 'default') === rt.id
                      return (
                        <div
                          key={rt.id}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '9px 12px',
                            borderRadius: 10,
                            border: `1.5px solid ${selected ? themeColor : 'rgba(134,150,160,0.15)'}`,
                            background: selected ? `${themeColor}18` : '#2a3942',
                            cursor: 'pointer',
                            transition: 'all 0.15s',
                          }}
                          onClick={() => {
                            saveContactRingtone(activeContact.id, rt.id)
                            if (rt.id !== 'none') playRingtone(rt.id)
                          }}
                        >
                          <span style={{ fontSize: 18, flexShrink: 0 }}>{rt.emoji}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ color: selected ? themeColor : '#e9edef', fontSize: 13, fontWeight: selected ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rt.label}</div>
                            <div style={{ color: '#8696a0', fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rt.desc}</div>
                          </div>
                          {selected && (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2.5" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* About section */}
                <div style={{ background: '#202c33', padding: '16px 20px', margin: '6px 0', borderTop: '1px solid rgba(134,150,160,0.08)', borderBottom: '1px solid rgba(134,150,160,0.08)' }}>
                  <div style={{ color: themeColor, fontSize: 12, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>About</div>
                  <div style={{ color: '#e9edef', fontSize: 14, lineHeight: 1.6 }}>{activeContact.about || 'Hey there! I am using SPVB.'}</div>
                </div>
                {/* Phone section */}
                {activeContact.phone && (
                  <div style={{ background: '#202c33', padding: '16px 20px', margin: '6px 0', borderTop: '1px solid rgba(134,150,160,0.08)', borderBottom: '1px solid rgba(134,150,160,0.08)' }}>
                    <div style={{ color: themeColor, fontSize: 12, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Phone</div>
                    <div style={{ color: '#e9edef', fontSize: 14 }}>+{activeContact.phone}</div>
                  </div>
                )}
                {/* Shared media */}
                {(() => {
                  const sharedMedia = (liveMessages[activeContact.id] || []).filter(m => m.media_url && !m.pending)
                  if (!sharedMedia.length) return null
                  const images = sharedMedia.filter(m => m.media_type === 'image')
                  const videos = sharedMedia.filter(m => m.media_type === 'video')
                  const docs = sharedMedia.filter(m => m.media_type === 'document')
                  const audios = sharedMedia.filter(m => m.media_type === 'audio')
                  return (
                    <div style={{ background: '#202c33', padding: '16px 20px', margin: '6px 0', borderTop: '1px solid rgba(134,150,160,0.08)', borderBottom: '1px solid rgba(134,150,160,0.08)' }}>
                      <div style={{ color: themeColor, fontSize: 12, fontWeight: 600, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Media, links and docs</div>
                      {/* Image/Video grid */}
                      {[...images, ...videos].length > 0 && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3, marginBottom: 10 }}>
                          {[...images, ...videos].slice(-9).map((m, i) => (
                            <div key={i} onClick={() => window.open(m.media_url, '_blank')} style={{ aspectRatio: '1', background: '#2a3942', borderRadius: 4, overflow: 'hidden', cursor: 'pointer', position: 'relative' }}>
                              {m.media_type === 'image'
                                ? <img src={m.media_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                : <>
                                    <video src={m.media_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted />
                                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
                                      <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                    </div>
                                  </>
                              }
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Documents */}
                      {docs.map((m, i) => (
                        <a key={i} href={m.media_url} download={m.fileName || 'document'} target="_blank" rel="noreferrer"
                          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(134,150,160,0.07)', textDecoration: 'none' }}>
                          <div style={{ width: 36, height: 40, background: 'rgba(81,87,174,0.2)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>📄</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ color: '#e9edef', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.fileName || 'Document'}</div>
                            <div style={{ color: '#8696a0', fontSize: 11 }}>Document</div>
                          </div>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        </a>
                      ))}
                      {/* Audio */}
                      {audios.map((m, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(134,150,160,0.07)' }}>
                          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(231,76,60,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>🎤</div>
                          <audio src={m.media_url} controls style={{ height: 30, flex: 1 }} />
                        </div>
                      ))}
                    </div>
                  )
                })()}
                {/* Block button */}
                <div style={{ padding: '16px 20px', marginTop: 'auto' }}>
                  <button onClick={() => { blockContact(activeContact.id); setShowContactInfo(false) }}
                    style={{ width: '100%', padding: '12px', background: 'rgba(234,84,85,0.1)', border: '1px solid rgba(234,84,85,0.25)', borderRadius: 10, color: '#ea5455', cursor: 'pointer', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                    Block {activeContact.name}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── CONTACT PICKER MODAL ── */}
      {showContactPicker && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowContactPicker(false) }}>
          <div style={{ background: '#111b21', borderRadius: 16, width: 340, maxHeight: '75vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => setShowContactPicker(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 2, display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div>
                <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>Send Contact</div>
                <div style={{ color: '#8696a0', fontSize: 12 }}>Select a contact to share</div>
              </div>
            </div>
            {/* Contact list */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {allContacts.filter(c => c.isSpvb && !c.isInvite).length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#8696a0', fontSize: 14 }}>No contacts available</div>
              ) : (
                allContacts.filter(c => c.isSpvb && !c.isInvite).map(c => (
                  <div key={c.id} onClick={() => { shareContact(c); setShowContactPicker(false) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px', cursor: 'pointer', borderBottom: '1px solid rgba(134,150,160,0.06)', transition: 'background 0.15s' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 18, overflow: 'hidden', flexShrink: 0 }}>
                      {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : c.initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                      {c.phone && <div style={{ color: '#8696a0', fontSize: 12, marginTop: 1 }}>{formatPhoneWithCode(c.phone)}</div>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── MOBILE LONG-PRESS BOTTOM SHEET ── */}
      {mobileMsgMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
          onClick={() => setMobileMsgMenu(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#1e2b33', borderRadius: '16px 16px 0 0', padding: '8px 0 24px', boxShadow: '0 -8px 32px rgba(0,0,0,0.6)', animation: 'slideUp 0.2s ease' }}>
            {/* Preview of the message */}
            <div style={{ padding: '10px 20px 12px', borderBottom: '1px solid rgba(134,150,160,0.12)', color: '#8696a0', fontSize: 13, maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {mobileMsgMenu.text || (mobileMsgMenu.media_type ? `📎 ${mobileMsgMenu.media_type}` : 'Message')}
            </div>
            {[
              { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00a884" strokeWidth="2.5"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>, label: 'Reply', color: '#e9edef', action: () => { setReplyTo({ id: mobileMsgMenu.id, text: mobileMsgMenu.text, sent: mobileMsgMenu.sent, media_url: mobileMsgMenu.media_url, media_type: mobileMsgMenu.media_type, fileName: mobileMsgMenu.fileName }); setMobileMsgMenu(null); setTimeout(() => inputRef.current?.focus(), 50) } },
              { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill={starredMsgIds.has(String(mobileMsgMenu.id)) ? '#f39c12' : 'none'} stroke={starredMsgIds.has(String(mobileMsgMenu.id)) ? '#f39c12' : '#8696a0'} strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>, label: starredMsgIds.has(String(mobileMsgMenu.id)) ? 'Unstar' : 'Star', color: starredMsgIds.has(String(mobileMsgMenu.id)) ? '#f39c12' : '#e9edef', action: () => { toggleStarMsg(mobileMsgMenu.id); setMobileMsgMenu(null) } },
              { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.5"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>, label: 'Forward', color: '#e9edef', action: () => { setForwardMsg(mobileMsgMenu); setShowForwardPicker(true); setMobileMsgMenu(null) } },
              { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>, label: 'Copy', color: '#e9edef', action: () => { navigator.clipboard?.writeText(mobileMsgMenu.text || '').catch(() => {}); setMobileMsgMenu(null) } },
              { icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>, label: 'Delete', color: '#e74c3c', action: () => { setDeleteConfirmMsg(mobileMsgMenu); setMobileMsgMenu(null) } },
            ].map(({ icon, label, color, action }) => (
              <button key={label} onClick={action} style={{ width: '100%', padding: '15px 24px', background: 'none', border: 'none', color, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left' }}>
                {icon}{label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── CHAT LIST CONTEXT MENU (right-click on chat) ── */}
      {msgMenuId !== null && typeof msgMenuId === 'string' && msgMenuId.startsWith('chat_ctx_') && (() => {
        const chatCtxId = msgMenuId.replace('chat_ctx_', '')
        const isPinned = pinnedChatIds.has(chatCtxId)
        const isArchived = archivedChats.has(chatCtxId)
        const currentLabel = chatLabels[chatCtxId]
        const menuBtnStyle = { width: '100%', padding: '12px 18px', background: 'none', border: 'none', color: '#e9edef', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 500 }} onClick={() => setMsgMenuId(null)}>
            <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', left: msgMenuPos.x, top: msgMenuPos.y, background: '#1e2b33', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.7)', zIndex: 501, minWidth: 200, overflow: 'hidden', border: '1px solid rgba(134,150,160,0.15)', animation: 'msgIn 0.12s ease-out' }}>
              <button onClick={() => { togglePinChat(chatCtxId); setMsgMenuId(null) }} style={menuBtnStyle} onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill={isPinned ? '#00a884' : 'none'} stroke={isPinned ? '#00a884' : '#8696a0'} strokeWidth="2"><path d="M16 1v8l2 2-8 8-2-2H1l8-8 2 2V1h5z"/></svg>
                {isPinned ? 'Unpin Chat' : 'Pin Chat'}
              </button>
              <div style={{ height: 1, background: 'rgba(134,150,160,0.1)' }} />
              <button onClick={() => { toggleArchiveChat(chatCtxId); setMsgMenuId(null) }} style={menuBtnStyle} onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                {isArchived ? 'Unarchive Chat' : 'Archive Chat'}
              </button>
              <div style={{ height: 1, background: 'rgba(134,150,160,0.1)' }} />
              <div style={{ padding: '8px 18px 4px', color: '#8696a0', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Label</div>
              {LABEL_DEFS.map(ldef => (
                <button key={ldef.id} onClick={() => { setChatLabel(chatCtxId, currentLabel === ldef.id ? null : ldef.id); setMsgMenuId(null) }} style={{ ...menuBtnStyle, color: currentLabel === ldef.id ? ldef.color : '#e9edef' }} onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: ldef.color, flexShrink: 0 }} />
                  {ldef.label} {currentLabel === ldef.id ? '✓' : ''}
                </button>
              ))}
            </div>
          </div>
        )
      })()}

      {/* ── MESSAGE CONTEXT MENU (fixed so it's never clipped by scroll) ── */}
      {msgMenuId !== null && !(typeof msgMenuId === 'string' && msgMenuId.startsWith('chat_ctx_')) && (() => {
        const m = (liveMessages[activeId] || []).find(x => x.id === msgMenuId)
          || (activeId === 'bot' ? botMsgs : []).find(x => x.id === msgMenuId)
        if (!m) return null
        const isStarred = starredMsgIds.has(String(m.id))
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 500 }} onClick={() => setMsgMenuId(null)}>
            <div
              onClick={e => e.stopPropagation()}
              style={{
                position: 'fixed', left: msgMenuPos.x, top: msgMenuPos.y,
                background: '#1e2b33', borderRadius: 12,
                boxShadow: '0 8px 32px rgba(0,0,0,0.7)', zIndex: 501,
                minWidth: 180, overflow: 'hidden',
                border: '1px solid rgba(134,150,160,0.15)',
                animation: 'msgIn 0.12s ease-out',
              }}>
              <button onClick={() => {
                setReplyTo({ id: m.id, text: m.text, sent: m.sent, media_url: m.media_url, media_type: m.media_type, fileName: m.fileName })
                setMsgMenuId(null)
                setTimeout(() => inputRef.current?.focus(), 50)
              }} style={{ width: '100%', padding: '12px 18px', background: 'none', border: 'none', color: '#e9edef', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00a884" strokeWidth="2.5"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>
                Reply
              </button>
              <div style={{ height: 1, background: 'rgba(134,150,160,0.1)' }} />
              <button onClick={() => { toggleStarMsg(m.id); setMsgMenuId(null) }} style={{ width: '100%', padding: '12px 18px', background: 'none', border: 'none', color: isStarred ? '#f39c12' : '#e9edef', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill={isStarred ? '#f39c12' : 'none'} stroke={isStarred ? '#f39c12' : '#8696a0'} strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                {isStarred ? 'Unstar' : 'Star Message'}
              </button>
              <div style={{ height: 1, background: 'rgba(134,150,160,0.1)' }} />
              <button onClick={() => {
                navigator.clipboard?.writeText(m.text || '').catch(() => {})
                setMsgMenuId(null)
              }} style={{ width: '100%', padding: '12px 18px', background: 'none', border: 'none', color: '#e9edef', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Copy
              </button>
              <div style={{ height: 1, background: 'rgba(134,150,160,0.1)' }} />
              <button onClick={() => { setForwardMsg(m); setShowForwardPicker(true); setMsgMenuId(null) }}
                style={{ width: '100%', padding: '12px 18px', background: 'none', border: 'none', color: '#e9edef', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.5"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
                Forward
              </button>
              <div style={{ height: 1, background: 'rgba(134,150,160,0.1)' }} />
              <button onClick={() => { setDeleteConfirmMsg(m); setMsgMenuId(null) }}
                style={{ width: '100%', padding: '12px 18px', background: 'none', border: 'none', color: '#e74c3c', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.background = '#2a3942'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                Delete
              </button>
            </div>
          </div>
        )
      })()}

      {/* ── DELETE CONFIRM POPUP ── */}
      {deleteConfirmMsg && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
          onClick={() => setDeleteConfirmMsg(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#233138', borderRadius: 16, width: 320, boxShadow: '0 16px 48px rgba(0,0,0,0.6)', overflow: 'hidden', border: '1px solid rgba(134,150,160,0.12)' }}>
            {/* Header */}
            <div style={{ padding: '20px 20px 14px', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(231,76,60,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </div>
                <span style={{ color: '#e9edef', fontSize: 16, fontWeight: 700 }}>Delete Message</span>
              </div>
              <div style={{ color: '#8696a0', fontSize: 13, lineHeight: 1.5, paddingLeft: 46 }}>
                {deleteConfirmMsg.sent ? 'Choose how to delete this message.' : 'You can only delete this message for yourself.'}
              </div>
            </div>
            {/* Actions */}
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {deleteConfirmMsg.sent && (
                <button
                  onClick={async () => {
                    const token = localStorage.getItem('token')
                    const mid = deleteConfirmMsg.id
                    try { await fetch(apiUrl(`/api/messages/${mid}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }) } catch (_) {}
                    setLiveMessages(prev => {
                      const updated = {}
                      for (const [k, msgs] of Object.entries(prev)) updated[k] = msgs.filter(x => x.id !== mid)
                      return updated
                    })
                    setDeleteConfirmMsg(null)
                  }}
                  style={{ width: '100%', padding: '12px 16px', background: 'rgba(231,76,60,0.12)', border: '1px solid rgba(231,76,60,0.25)', borderRadius: 10, color: '#e74c3c', fontSize: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(231,76,60,0.22)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(231,76,60,0.12)'}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                  Delete for Everyone
                </button>
              )}
              <button
                onClick={() => {
                  const mid = deleteConfirmMsg.id
                  setLiveMessages(prev => ({ ...prev, [activeId]: (prev[activeId] || []).filter(x => x.id !== mid) }))
                  setDeleteConfirmMsg(null)
                }}
                style={{ width: '100%', padding: '12px 16px', background: 'rgba(134,150,160,0.08)', border: '1px solid rgba(134,150,160,0.15)', borderRadius: 10, color: '#e9edef', fontSize: 14, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(134,150,160,0.15)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(134,150,160,0.08)'}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Delete for Me
              </button>
              <button
                onClick={() => setDeleteConfirmMsg(null)}
                style={{ width: '100%', padding: '12px 16px', background: 'none', border: '1px solid rgba(134,150,160,0.12)', borderRadius: 10, color: '#8696a0', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(134,150,160,0.06)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── BROADCAST MODAL (#9) ── */}
      {showBroadcastModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={e => { if (e.target === e.currentTarget) setShowBroadcastModal(false) }}>
          <div style={{ background: '#111b21', borderRadius: 16, width: 360, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => setShowBroadcastModal(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 2, display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div style={{ flex: 1 }}>
                <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>Broadcast Message</div>
                <div style={{ color: '#8696a0', fontSize: 12 }}>{broadcastRecipients.length} selected</div>
              </div>
              {broadcastRecipients.length > 0 && <button onClick={sendBroadcast} disabled={broadcastSending || !broadcastMsg.trim()} style={{ background: themeGradient, border: 'none', borderRadius: 8, padding: '8px 14px', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: broadcastSending ? 0.7 : 1 }}>{broadcastSending ? 'Sending…' : 'Send'}</button>}
            </div>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <textarea value={broadcastMsg} onChange={e => setBroadcastMsg(e.target.value)} placeholder="Type your broadcast message…" rows={3} style={{ width: '100%', background: '#2a3942', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 8, padding: '10px 12px', color: '#e9edef', fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {allContacts.filter(c => c.isSpvb && !c.isInvite && c.id !== 'bot').map(c => {
                const sel = broadcastRecipients.includes(c.id)
                return (
                  <div key={c.id} onClick={() => setBroadcastRecipients(prev => sel ? prev.filter(x => x !== c.id) : [...prev, c.id])}
                    style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px', cursor: 'pointer', background: sel ? 'rgba(0,168,132,0.08)' : 'none' }}
                    onMouseEnter={e => e.currentTarget.style.background = sel ? 'rgba(0,168,132,0.12)' : 'rgba(255,255,255,0.04)'}
                    onMouseLeave={e => e.currentTarget.style.background = sel ? 'rgba(0,168,132,0.08)' : 'none'}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 18, overflow: 'hidden', flexShrink: 0 }}>
                      {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : c.initials}
                    </div>
                    <div style={{ flex: 1 }}><div style={{ color: '#e9edef', fontSize: 14 }}>{c.name}</div></div>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', background: sel ? themeColor : 'transparent', border: `2px solid ${sel ? themeColor : 'rgba(134,150,160,0.4)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {sel && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── POLL MODAL (#7) ── */}
      {showPollModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={e => { if (e.target === e.currentTarget) setShowPollModal(false) }}>
          <div style={{ background: '#111b21', borderRadius: 16, width: 360, boxShadow: '0 16px 48px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => setShowPollModal(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 2, display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>Create Poll</div>
            </div>
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input value={pollQuestion} onChange={e => setPollQuestion(e.target.value)} placeholder="Question…" style={{ background: '#2a3942', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 8, padding: '10px 12px', color: '#e9edef', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box' }} />
              <div style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }}>Options</div>
              {pollOptions.map((opt, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 8 }}>
                  <input value={opt} onChange={e => { const n = [...pollOptions]; n[idx] = e.target.value; setPollOptions(n) }} placeholder={`Option ${idx + 1}`} style={{ flex: 1, background: '#2a3942', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 8, padding: '10px 12px', color: '#e9edef', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
                  {pollOptions.length > 2 && <button onClick={() => setPollOptions(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', color: '#ea5455', cursor: 'pointer', padding: 4 }}>✕</button>}
                </div>
              ))}
              {pollOptions.length < 6 && <button onClick={() => setPollOptions(prev => [...prev, ''])} style={{ background: 'none', border: `1px dashed rgba(134,150,160,0.3)`, borderRadius: 8, padding: '10px', color: '#8696a0', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>+ Add Option</button>}
              <button onClick={sendPoll} disabled={!pollQuestion.trim() || pollOptions.filter(o => o.trim()).length < 2} style={{ background: themeGradient, border: 'none', borderRadius: 10, padding: '12px', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', opacity: (!pollQuestion.trim() || pollOptions.filter(o => o.trim()).length < 2) ? 0.5 : 1 }}>Send Poll</button>
            </div>
          </div>
        </div>
      )}

      {/* ── STARRED MESSAGES PANEL (#4) ── */}
      {showStarredPanel && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={e => { if (e.target === e.currentTarget) setShowStarredPanel(false) }}>
          <div style={{ background: '#111b21', borderRadius: 16, width: 380, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => setShowStarredPanel(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 2, display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>Starred Messages</div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {(() => {
                const allMsgs = [...Object.values(liveMessages).flat(), ...botMsgs].filter(m => starredMsgIds.has(String(m.id)))
                if (allMsgs.length === 0) return <div style={{ padding: 40, textAlign: 'center', color: '#8696a0', fontSize: 14 }}>No starred messages yet.<br/><span style={{ fontSize: 12 }}>Right-click a message and tap Star.</span></div>
                return allMsgs.map(m => (
                  <div key={m.id} style={{ padding: '12px 20px', borderBottom: '1px solid rgba(134,150,160,0.06)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="#f39c12" stroke="none" style={{ flexShrink: 0, marginTop: 3 }}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: '#e9edef', fontSize: 13 }}>{m.text || (m.media_type ? `📎 ${m.media_type}` : '')}</div>
                      {m.time && <div style={{ color: '#8696a0', fontSize: 11, marginTop: 4 }}>{m.time}</div>}
                    </div>
                    <button onClick={() => toggleStarMsg(m.id)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 4 }}>✕</button>
                  </div>
                ))
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── MEDIA SEND PREVIEW MODAL (view-once toggle) ── */}
      {pendingMediaFile && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 700, display: 'flex', flexDirection: 'column', background: '#111b21' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
            <button onClick={() => { URL.revokeObjectURL(pendingMediaFile.previewUrl); setPendingMediaFile(null) }}
              style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 4, display: 'flex' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span style={{ color: '#e9edef', fontWeight: 600, fontSize: 16, flex: 1 }}>Send Media</span>
            <span style={{ color: '#8696a0', fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pendingMediaFile.file.name}</span>
          </div>

          {/* Preview */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b141a', overflow: 'hidden' }}>
            {pendingMediaFile.isImage
              ? <img src={pendingMediaFile.previewUrl} alt="preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              : <video src={pendingMediaFile.previewUrl} controls style={{ maxWidth: '100%', maxHeight: '100%' }} />}
          </div>

          {/* Bottom bar */}
          <div style={{ background: '#202c33', borderTop: '1px solid rgba(134,150,160,0.1)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* View-once toggle */}
            <div onClick={() => setPendingMediaViewOnce(p => !p)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, cursor: 'pointer', userSelect: 'none' }}>
              <div style={{ width: 42, height: 24, background: pendingMediaViewOnce ? themeColor : '#2a3942', borderRadius: 12, position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                <div style={{ position: 'absolute', top: 3, left: pendingMediaViewOnce ? 20 : 3, width: 18, height: 18, background: 'white', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
              </div>
              <div>
                <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 500 }}>View once</div>
                <div style={{ color: '#8696a0', fontSize: 11 }}>Recipient can view only once</div>
              </div>
            </div>
            {/* Send button */}
            <button onClick={() => {
              const f = pendingMediaFile.file
              URL.revokeObjectURL(pendingMediaFile.previewUrl)
              setPendingMediaFile(null)
              if (pendingMediaViewOnce) setViewOnceMode(true)
              sendMedia(f)
            }}
              style={{ width: 52, height: 52, borderRadius: '50%', background: themeGradient, border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: `0 2px 12px ${themeColor}66` }}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* ── WALLPAPER MODAL (#14) ── */}
      {showWallpaperModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={e => { if (e.target === e.currentTarget) setShowWallpaperModal(false) }}>
          <div style={{ background: '#111b21', borderRadius: 16, width: 340, boxShadow: '0 16px 48px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => setShowWallpaperModal(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 2, display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>Chat Wallpaper</div>
            </div>
            <div style={{ padding: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {/* Upload custom wallpaper */}
              <label style={{ padding: '16px', background: '#2a3942', border: `2px dashed rgba(134,150,160,0.4)`, borderRadius: 10, cursor: 'pointer', color: '#8696a0', fontSize: 13, height: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 4 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Upload Photo
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
                  const file = e.target.files?.[0]; if (!file) return
                  const token = localStorage.getItem('token')
                  const formData = new FormData()
                  formData.append('file', file)
                  const oldWp = chatWallpapers[String(activeId)]
                  if (oldWp && !oldWp.startsWith('data:')) formData.append('old_url', oldWp)
                  try {
                    const res = await fetch(apiUrl('/api/upload?type=wallpaper'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
                    if (res.ok) {
                      const { url } = await res.json()
                      setChatWallpaper(activeId, url)
                    }
                  } catch {}
                  setShowWallpaperModal(false)
                }} />
              </label>
              {/* Custom wallpaper preview if active */}
              {(() => { const wp = chatWallpapers[String(activeId)]; return wp && !WALLPAPER_PRESETS.some(p => p.id === wp) })() && (
                <button onClick={async () => {
                  const token = localStorage.getItem('token')
                  const oldWp = chatWallpapers[String(activeId)]
                  if (oldWp && !oldWp.startsWith('data:')) {
                    try { await fetch(apiUrl('/api/upload?type=wallpaper'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: (() => { const fd = new FormData(); fd.append('old_url', oldWp); return fd })() }) } catch {}
                  }
                  setChatWallpaper(activeId, null); setShowWallpaperModal(false)
                }}
                  style={{ padding: '8px', background: `url(${chatWallpapers[String(activeId)]}) center/cover`, border: `2px solid ${themeColor}`, borderRadius: 10, cursor: 'pointer', height: 70, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                  <span style={{ background: 'rgba(0,0,0,0.6)', color: '#ea5455', fontSize: 11, padding: '2px 6px', borderRadius: 4 }}>Remove</span>
                </button>
              )}
              {WALLPAPER_PRESETS.map(wp => {
                const isActive = chatWallpapers[String(activeId)] === wp.id || (!chatWallpapers[String(activeId)] && wp.id === 'none')
                return (
                  <button key={wp.id} onClick={() => { setChatWallpaper(activeId, wp.id === 'none' ? null : wp.id); setShowWallpaperModal(false) }}
                    style={{ padding: '16px', background: wp.bg || '#2a3942', backgroundImage: wp.bg || undefined, backgroundSize: wp.bgSize, border: `2px solid ${isActive ? themeColor : 'transparent'}`, borderRadius: 10, cursor: 'pointer', color: '#e9edef', fontSize: 13, fontWeight: isActive ? 700 : 400, height: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 4 }}>
                    {wp.label}
                    {isActive && <span style={{ fontSize: 10, color: themeColor }}>Active</span>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── ACCOUNT SWITCHER (#16) ── */}
      {showAccountSwitcher && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'rgba(0,0,0,0.55)' }} onClick={e => { if (e.target === e.currentTarget) setShowAccountSwitcher(false) }}>
          <div style={{ background: '#111b21', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 480, boxShadow: '0 -8px 40px rgba(0,0,0,0.5)', overflow: 'hidden', paddingBottom: 'env(safe-area-inset-bottom)' }}>
            {/* Handle bar */}
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10, paddingBottom: 6 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(134,150,160,0.3)' }} />
            </div>
            <div style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', padding: '4px 20px 12px' }}>Accounts</div>

            {/* Current account */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 20px 10px', background: 'rgba(255,255,255,0.03)' }}>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: themeGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 20, overflow: 'hidden' }}>
                  {user?.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (user?.display_name || user?.username || 'U')[0].toUpperCase()}
                </div>
                <div style={{ position: 'absolute', bottom: 1, right: 1, width: 12, height: 12, borderRadius: '50%', background: '#25d366', border: '2px solid #111b21' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#e9edef', fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.display_name || user?.username}</div>
                <div style={{ color: '#8696a0', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email || user?.username}</div>
              </div>
              <div style={{ color: '#25d366', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>Active</div>
            </div>

            {/* Other saved accounts */}
            {savedAccounts.filter(a => a.id !== user?.id).map(acc => (
              <div key={acc.id} style={{ display: 'flex', alignItems: 'center', borderTop: '1px solid rgba(134,150,160,0.06)' }}>
                <button onClick={() => { setShowAccountSwitcher(false); switchAccount(acc) }}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e9edef', fontWeight: 700, fontSize: 20, overflow: 'hidden', flexShrink: 0 }}>
                    {acc.avatar_url ? <img src={acc.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (acc.display_name || acc.username || 'U')[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#e9edef', fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.display_name || acc.username}</div>
                    <div style={{ color: '#8696a0', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.email || acc.username}</div>
                  </div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                <button onClick={() => removeAccount(acc.id)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: '12px 16px 12px 0', display: 'flex' }} title="Remove">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            ))}

            {/* Add account */}
            <button onClick={addNewAccount} style={{ width: '100%', padding: '16px 20px', background: 'none', border: 'none', borderTop: '1px solid rgba(134,150,160,0.1)', color: themeColor, cursor: 'pointer', fontSize: 15, fontFamily: 'inherit', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', border: `2px dashed ${themeColor}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </div>
              <span style={{ fontWeight: 500 }}>Add Account</span>
            </button>
          </div>
        </div>
      )}

      {/* ── FORWARD PICKER MODAL ── */}
      {showForwardPicker && forwardMsg && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowForwardPicker(false); setForwardMsg(null) } }}>
          <div style={{ background: '#111b21', borderRadius: 16, width: 340, maxHeight: '75vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', background: '#202c33', borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => { setShowForwardPicker(false); setForwardMsg(null) }} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', padding: 2, display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div>
                <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>Forward to</div>
                <div style={{ color: '#8696a0', fontSize: 12 }}>Select a contact</div>
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {allContacts.filter(c => c.isSpvb && !c.isInvite && c.id !== 'bot').length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#8696a0', fontSize: 14 }}>No contacts available</div>
              ) : (
                allContacts.filter(c => c.isSpvb && !c.isInvite && c.id !== 'bot').map(c => (
                  <div key={c.id} onClick={() => forwardMessage(forwardMsg, c)}
                    style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px', cursor: 'pointer', borderBottom: '1px solid rgba(134,150,160,0.06)', transition: 'background 0.15s' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 18, overflow: 'hidden', flexShrink: 0 }}>
                      {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : c.initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                      {c.phone && <div style={{ color: '#8696a0', fontSize: 12, marginTop: 1 }}>{formatPhoneWithCode(c.phone)}</div>}
                    </div>
                    <div style={{ flexShrink: 0 }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── PROFILE IMAGE POPUP (root-level, works on mobile + desktop) ── */}
      {showProfileImagePopup && (profilePopupContact || activeContact) && (() => {
        const pc = profilePopupContact || activeContact
        const pStatus = getContactStatus(pc)
        const closePopup = () => { setShowProfileImagePopup(false); setProfilePopupContact(null) }
        return (
          <div onClick={closePopup} style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', animation: 'fadeIn 0.15s ease' }}>
            <div onClick={e => e.stopPropagation()} style={{ background: '#1e2d35', borderRadius: 20, width: '100%', maxWidth: 340, overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.8)', animation: 'scaleIn 0.18s ease', maxHeight: '90dvh', overflowY: 'auto' }}>

              {/* Full DP photo area */}
              <div style={{ position: 'relative', width: '100%', aspectRatio: '1 / 1', background: pc.color || '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {pc.avatar_url
                  ? <img src={pc.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  : <span style={{ color: 'white', fontWeight: 700, fontSize: 80 }}>{pc.id === 'bot' ? '🤖' : pc.initials}</span>
                }
                {/* Top gradient for close btn readability */}
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 60, background: 'linear-gradient(to bottom, rgba(0,0,0,0.5), transparent)', pointerEvents: 'none' }} />
                {/* Close button */}
                <button onClick={closePopup} style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: '50%', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'white', flexShrink: 0 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>

              {/* Info section */}
              <div style={{ padding: '16px 20px 4px', textAlign: 'center' }}>
                <div style={{ color: '#e9edef', fontSize: 19, fontWeight: 700 }}>{pc.name}</div>
                {pc.nickname && pc.nickname !== pc.realName && (
                  <div style={{ color: '#8696a0', fontSize: 12, marginTop: 2 }}>{pc.realName}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 5 }}>
                  {pStatus.isOnline && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#25d366', flexShrink: 0 }} />}
                  <span style={{ color: pStatus.isOnline ? '#25d366' : '#8696a0', fontSize: 13 }}>{pStatus.label}</span>
                </div>
                {pc.about && <div style={{ color: '#8696a0', fontSize: 12, marginTop: 6, fontStyle: 'italic' }}>{pc.about}</div>}
              </div>

              {/* Phone / Email */}
              {(pc.phone || pc.email) && (
                <div style={{ padding: '10px 20px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pc.phone && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                      </div>
                      <div>
                        <div style={{ color: '#e9edef', fontSize: 13 }}>{pc.phone}</div>
                        <div style={{ color: '#8696a0', fontSize: 10 }}>Mobile</div>
                      </div>
                    </div>
                  )}
                  {pc.email && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: '#e9edef', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pc.email}</div>
                        <div style={{ color: '#8696a0', fontSize: 10 }}>Email</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Action buttons */}
              {pc.id !== 'bot' && !pc.isInvite && (
                <div style={{ display: 'flex', borderTop: '1px solid rgba(134,150,160,0.12)', padding: '14px 8px 18px', marginTop: 14 }}>
                  <button onClick={() => { closePopup(); selectChat(pc.id) }} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: '#8696a0' }}>
                    <div style={{ width: 46, height: 46, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    </div>
                    <span style={{ fontSize: 11, color: '#e9edef' }}>Message</span>
                  </button>
                  <button onClick={() => { closePopup(); initiateCall(pc, 'voice') }} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: '#8696a0' }}>
                    <div style={{ width: 46, height: 46, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.38 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    </div>
                    <span style={{ fontSize: 11, color: '#e9edef' }}>Voice</span>
                  </button>
                  <button onClick={() => { closePopup(); initiateCall(pc, 'video') }} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: '#8696a0' }}>
                    <div style={{ width: 46, height: 46, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                    </div>
                    <span style={{ fontSize: 11, color: '#e9edef' }}>Video</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── FULL SCREEN CALL ── */}
      {/* CallScreen stays MOUNTED to keep WebRTC alive — only hidden via CSS when minimized */}
      {/* Offline contact call modal */}
      {callOfflineContact && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setCallOfflineContact(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#1e2d35', borderRadius: 20, padding: '28px 28px 20px', width: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: callOfflineContact.contact?.color || '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 24, overflow: 'hidden' }}>
              {callOfflineContact.contact?.avatar_url
                ? <img src={callOfflineContact.contact.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : callOfflineContact.contact?.initials}
            </div>
            <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 700 }}>{callOfflineContact.contact?.name}</div>
            <div style={{ fontSize: 28 }}>{callOfflineContact.type === 'video' ? '📹' : '📞'}</div>
            <div style={{ color: '#f39c12', fontSize: 14, fontWeight: 600 }}>User is offline</div>
            <div style={{ color: '#8696a0', fontSize: 12, textAlign: 'center', lineHeight: 1.5 }}>
              {callOfflineContact.contact?.name} is not connected to the internet right now. You can send them a message instead.
            </div>
            <div style={{ display: 'flex', gap: 10, width: '100%', marginTop: 4 }}>
              <button onClick={() => setCallOfflineContact(null)} style={{ flex: 1, padding: '11px', background: '#2a3942', border: 'none', borderRadius: 10, color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>Cancel</button>
              <button onClick={() => { selectChat(callOfflineContact.contact.id); setCallOfflineContact(null) }} style={{ flex: 1, padding: '11px', background: themeGradient, border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>Message</button>
            </div>
          </div>
        </div>
      )}

      {/* Ringtone save-as popup */}
      {pendingRingtoneUpload && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => { if (previewAudioRef.current) { try { previewAudioRef.current.pause() } catch {}; previewAudioRef.current = null }; setPendingRingtoneUpload(null) }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#1e2d35', borderRadius: 20, padding: '24px 24px 20px', width: 300, boxShadow: '0 16px 48px rgba(0,0,0,0.7)' }}>
            <div style={{ color: 'white', fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Save Ringtone As</div>
            <div style={{ color: '#8696a0', fontSize: 13, marginBottom: 16 }}>"{pendingRingtoneUpload.fileName}"</div>
            <button onClick={() => {
              if (previewAudioRef.current) { try { previewAudioRef.current.pause() } catch {}; previewAudioRef.current = null }
              try { const a = new Audio(pendingRingtoneUpload.dataUrl); a.volume = 0.8; previewAudioRef.current = a; a.play().catch(() => {}) } catch {}
            }} style={{ width: '100%', padding: '9px', background: '#2a3942', border: 'none', borderRadius: 10, color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, marginBottom: 10 }}>▶ Preview</button>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => {
                if (previewAudioRef.current) { try { previewAudioRef.current.pause() } catch {}; previewAudioRef.current = null }
                localStorage.setItem('custom_msg_ringtone_data', pendingRingtoneUpload.dataUrl)
                localStorage.setItem('custom_msg_ringtone_name', pendingRingtoneUpload.fileName)
                setMsgRingtone('custom_msg'); localStorage.setItem('msg_ringtone', 'custom_msg')
                setPendingRingtoneUpload(null)
              }} style={{ flex: 1, padding: '11px', background: themeGradient, border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>💬 Message Tone</button>
              <button onClick={() => {
                if (previewAudioRef.current) { try { previewAudioRef.current.pause() } catch {}; previewAudioRef.current = null }
                localStorage.setItem('custom_call_ringtone_data', pendingRingtoneUpload.dataUrl)
                localStorage.setItem('custom_call_ringtone_name', pendingRingtoneUpload.fileName)
                setCallRingtone('custom_call'); localStorage.setItem('call_ringtone', 'custom_call')
                setPendingRingtoneUpload(null)
              }} style={{ flex: 1, padding: '11px', background: '#25445a', border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>📞 Call Ringtone</button>
            </div>
            <button onClick={() => { if (previewAudioRef.current) { try { previewAudioRef.current.pause() } catch {}; previewAudioRef.current = null }; setPendingRingtoneUpload(null) }} style={{ width: '100%', marginTop: 10, padding: '9px', background: 'transparent', border: 'none', color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      {activeCall && (
        // No wrapper div — CallScreen owns all its position:fixed elements directly.
        // A wrapper with pointerEvents:none blocked PiP button clicks entirely.
        // CallScreen's full-screen div is zIndex:2001, PiP is zIndex:1500 — both
        // render and receive clicks correctly without any wrapper interference.
        <CallScreen
          call={activeCall}
          wsRef={wsRef}
          minimized={callMinimized}
          onMinimize={() => setCallMinimized(true)}
          onExpand={() => setCallMinimized(false)}
          onEnd={(callResult) => {
            if (activeCall?.contact?.id && activeCall.contact.id !== 'bot') {
              const { duration = 0, connected = false, rejected = false } = callResult || {}
              saveCallLog({
                contact_id: activeCall.contact.id,
                call_type: activeCall.type,
                direction: activeCall.role === 'caller' ? 'outgoing' : 'incoming',
                status: connected ? 'completed' : rejected ? 'rejected' : 'missed',
                duration,
              })
            }
            setActiveCall(null); setCallMinimized(false)
          }}
        />
      )}

      {/* ── INCOMING CALL BANNER ── */}
      {incomingCall && !activeCall && (
        <IncomingCallBanner
          call={incomingCall}
          onAccept={acceptCall}
          onDecline={declineCall}
          themeColor={themeColor}
        />
      )}

      {/* ── IMAGE CROPPER MODAL ── */}
      {cropSrc && cropCallback && (
        <ImageCropper
          src={cropSrc}
          onCrop={cropCallback}
          onCancel={() => { setCropSrc(null); setCropCallback(null) }}
        />
      )}

      {/* ── ADD CONTACT MODAL ── */}
      {showAddContact && (
        <AddContactModal
          onClose={() => setShowAddContact(false)}
          onSaved={handleContactSaved}
          themeColor={themeColor}
        />
      )}

      {/* ── STATUS POST MODAL ── */}
      {showStatusModal && (() => {
        const STATUS_BG_OPTIONS = [
          { color: '#075e54', label: 'Forest' },
          { color: '#128c7e', label: 'Teal' },
          { color: '#1a73e8', label: 'Ocean' },
          { color: '#6b48ff', label: 'Purple' },
          { color: '#e91e63', label: 'Rose' },
          { color: '#ff5722', label: 'Sunset' },
          { color: '#ff9800', label: 'Amber' },
          { color: '#2c3e50', label: 'Midnight' },
          { color: '#8e44ad', label: 'Violet' },
          { color: '#16a085', label: 'Emerald' },
        ]
        const STATUS_EMOJIS = [
          '😀','😂','😍','🥰','😎','🥺','😢','😡','🤔','😴',
          '👍','👎','👏','🙏','💪','🤝','🫶','✌️','🤞','👋',
          '❤️','🔥','✨','🎉','💯','🌟','🎵','🎮','🚀','🎯',
        ]
        const activeBg = statusBgColor || themeColor
        const canPost = statusPostType === 'text' ? !!myStatus.trim() : statusPostType === 'photo' ? !!statusImageUrl : !!statusVideoUrl

        return (
          <div
            onClick={() => { setShowStatusModal(false); setStatusPostType('text'); setStatusVideoFile(null); setStatusVideoUrl(null); setStatusVideoError(''); setMyStatus(''); setStatusEmojiOpen(false) }}
            style={{
              position: 'fixed', inset: 0, zIndex: 1000,
              background: 'rgba(0,0,0,0.85)',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              backdropFilter: 'blur(6px)',
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                width: '100%', maxWidth: 480,
                background: '#111b21',
                borderRadius: '20px 20px 0 0',
                overflow: 'hidden',
                boxShadow: '0 -8px 40px rgba(0,0,0,0.6)',
                display: 'flex', flexDirection: 'column',
                maxHeight: '92vh',
              }}
            >
              {/* ── Preview ── */}
              {statusPostType === 'text' && (
                <div style={{
                  height: 200,
                  background: `radial-gradient(ellipse at 40% 40%, ${activeBg}dd 0%, #0a0f1a 100%)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '20px 32px',
                  position: 'relative', flexShrink: 0,
                }}>
                  <div style={{
                    color: 'white',
                    fontSize: myStatus.length > 80 ? 17 : myStatus.length > 40 ? 22 : myStatus.length > 15 ? 28 : 32,
                    fontWeight: 700, textAlign: 'center', lineHeight: 1.45,
                    wordBreak: 'break-word',
                    textShadow: '0 2px 16px rgba(0,0,0,0.5)',
                    letterSpacing: '-0.3px',
                  }}>
                    {myStatus || <span style={{ opacity: 0.3, fontWeight: 400, fontSize: 18 }}>Your status preview…</span>}
                  </div>
                </div>
              )}

              {/* ── Tab row ── */}
              <div style={{ display: 'flex', background: '#1a2530', flexShrink: 0 }}>
                {[
                  { id: 'text',  icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>, label: 'Text' },
                  { id: 'photo', icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>, label: 'Photo' },
                  { id: 'video', icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>, label: 'Video' },
                ].map(({ id, icon, label }) => (
                  <button key={id}
                    onClick={() => { setStatusPostType(id); setStatusVideoFile(null); setStatusVideoUrl(null); setStatusImageFile(null); setStatusImageUrl(null); setStatusVideoError(''); setStatusEmojiOpen(false) }}
                    style={{
                      flex: 1, padding: '14px 0', background: 'none', border: 'none', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                      color: statusPostType === id ? themeColor : '#8696a0',
                      fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                      borderBottom: `2.5px solid ${statusPostType === id ? themeColor : 'transparent'}`,
                      transition: 'all 0.15s',
                    }}
                  >
                    {icon} {label}
                  </button>
                ))}
              </div>

              {/* ── Body ── */}
              <div style={{ padding: '18px 18px 0', overflowY: 'auto', flex: 1 }}>

                {/* ─ TEXT MODE ─ */}
                {statusPostType === 'text' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {/* Input row with emoji button */}
                    <div style={{ position: 'relative' }}>
                      <textarea
                        placeholder="What's on your mind? ✨"
                        value={myStatus}
                        onChange={e => setMyStatus(e.target.value)}
                        rows={3}
                        autoFocus
                        style={{
                          width: '100%', boxSizing: 'border-box',
                          padding: '13px 48px 13px 16px',
                          background: '#1e2d38',
                          border: `1.5px solid ${myStatus ? themeColor + '66' : 'rgba(134,150,160,0.15)'}`,
                          borderRadius: 14, color: '#e9edef', fontSize: 15,
                          fontFamily: 'inherit', outline: 'none', resize: 'none',
                          lineHeight: 1.5,
                          transition: 'border-color 0.2s',
                        }}
                      />
                      {/* Emoji toggle button inside input */}
                      <button
                        onClick={() => setStatusEmojiOpen(o => !o)}
                        style={{
                          position: 'absolute', right: 10, top: 10,
                          width: 32, height: 32, borderRadius: '50%',
                          background: statusEmojiOpen ? `${themeColor}33` : 'rgba(255,255,255,0.06)',
                          border: `1.5px solid ${statusEmojiOpen ? themeColor : 'rgba(255,255,255,0.1)'}`,
                          fontSize: 17, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'all 0.15s',
                        }}
                      >
                        😊
                      </button>
                    </div>

                    {/* Emoji picker */}
                    {statusEmojiOpen && (
                      <div style={{
                        background: '#1e2d38', borderRadius: 14,
                        border: '1px solid rgba(134,150,160,0.12)',
                        padding: '10px',
                      }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {STATUS_EMOJIS.map(e => (
                            <button
                              key={e}
                              onClick={() => { setMyStatus(t => t + e) }}
                              style={{
                                width: 38, height: 38, background: 'rgba(255,255,255,0.04)',
                                border: 'none', borderRadius: 8, fontSize: 20, cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'background 0.12s',
                              }}
                              onMouseEnter={el => { el.currentTarget.style.background = 'rgba(255,255,255,0.12)' }}
                              onMouseLeave={el => { el.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                            >
                              {e}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Background colour strip */}
                    <div>
                      <div style={{ color: '#8696a0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 10 }}>Background</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {STATUS_BG_OPTIONS.map(({ color, label }) => (
                          <button
                            key={color}
                            title={label}
                            onClick={() => setStatusBgColor(color)}
                            style={{
                              width: 34, height: 34, borderRadius: '50%',
                              background: color,
                              border: `3px solid ${statusBgColor === color ? 'white' : 'transparent'}`,
                              cursor: 'pointer', outline: 'none',
                              boxShadow: statusBgColor === color ? `0 0 0 2px ${color}` : 'none',
                              transition: 'all 0.15s',
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* ─ PHOTO MODE ─ */}
                {statusPostType === 'photo' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <input ref={statusImageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
                      const f = e.target.files?.[0]; e.target.value = ''
                      if (!f) return
                      const objUrl = URL.createObjectURL(f)
                      setCropSrc(objUrl)
                      setCropCallback(() => (blob) => {
                        URL.revokeObjectURL(objUrl)
                        setCropSrc(null); setCropCallback(null)
                        setStatusImageFile(Object.assign(new File([blob], f.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }), { _spvbCropped: true }))
                        setStatusImageUrl(URL.createObjectURL(blob))
                      })
                    }} />
                    {!statusImageUrl ? (
                      <div onClick={() => statusImageInputRef.current?.click()}
                        style={{ padding: '36px 20px', background: 'linear-gradient(135deg,#1e2d38,#1a2530)', border: `2px dashed ${themeColor}55`, borderRadius: 16, textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = themeColor }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = `${themeColor}55` }}
                      >
                        <div style={{ width: 64, height: 64, borderRadius: '50%', background: `${themeColor}22`, border: `2px solid ${themeColor}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                        </div>
                        <div style={{ color: '#e9edef', fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Upload a photo</div>
                        <div style={{ color: '#8696a0', fontSize: 13 }}>Tap to choose from gallery</div>
                      </div>
                    ) : (
                      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden' }}>
                        <img src={statusImageUrl} alt="status preview" style={{ width: '100%', maxHeight: 280, objectFit: 'cover', display: 'block' }} />
                        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6 }}>
                          <button onClick={() => statusImageInputRef.current?.click()} style={{ background: 'rgba(0,0,0,0.65)', border: 'none', color: '#fff', borderRadius: 20, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                            Change
                          </button>
                          <button onClick={() => { setStatusImageFile(null); setStatusImageUrl(null) }} style={{ background: 'rgba(229,57,53,0.85)', border: 'none', color: '#fff', borderRadius: 20, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ─ VIDEO MODE ─ */}
                {statusPostType === 'video' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <input ref={statusVideoInputRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={handleVideoSelect} />

                    {!statusVideoUrl ? (
                      <div
                        onClick={() => statusVideoInputRef.current?.click()}
                        style={{
                          padding: '36px 20px',
                          background: 'linear-gradient(135deg, #1e2d38 0%, #1a2530 100%)',
                          border: `2px dashed ${themeColor}55`,
                          borderRadius: 16, textAlign: 'center', cursor: 'pointer',
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = themeColor; e.currentTarget.style.background = `linear-gradient(135deg, #1e2d38 0%, ${themeColor}11 100%)` }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = `${themeColor}55`; e.currentTarget.style.background = 'linear-gradient(135deg, #1e2d38 0%, #1a2530 100%)' }}
                      >
                        <div style={{
                          width: 64, height: 64, borderRadius: '50%',
                          background: `${themeColor}22`,
                          border: `2px solid ${themeColor}44`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          margin: '0 auto 14px',
                        }}>
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="1.8">
                            <polygon points="23 7 16 12 23 17 23 7"/>
                            <rect x="1" y="5" width="15" height="14" rx="2"/>
                          </svg>
                        </div>
                        <div style={{ color: '#e9edef', fontWeight: 700, fontSize: 15, marginBottom: 5 }}>Choose a video</div>
                        <div style={{ color: '#8696a0', fontSize: 12, marginBottom: 12 }}>MP4, MOV, WebM · Max 60 seconds</div>
                        <div style={{
                          display: 'inline-flex', alignItems: 'center', gap: 8,
                          padding: '9px 20px', borderRadius: 24,
                          background: themeGradient, color: 'white',
                          fontSize: 13, fontWeight: 700,
                        }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                          Browse Files
                        </div>
                      </div>
                    ) : (
                      <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden' }}>
                        <video src={statusVideoUrl} style={{ width: '100%', display: 'block', maxHeight: 220, background: '#000', borderRadius: 14 }} controls />
                        <button
                          onClick={() => { setStatusVideoFile(null); setStatusVideoUrl(null) }}
                          style={{
                            position: 'absolute', top: 8, right: 8,
                            width: 30, height: 30,
                            background: 'rgba(0,0,0,0.7)', border: 'none', borderRadius: '50%',
                            color: 'white', cursor: 'pointer', fontSize: 14,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      </div>
                    )}

                    {statusVideoError && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ea5455', fontSize: 12, padding: '8px 12px', background: 'rgba(234,84,85,0.1)', borderRadius: 8 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        {statusVideoError}
                      </div>
                    )}

                    {/* Caption input */}
                    <div style={{ position: 'relative' }}>
                      <input
                        type="text"
                        placeholder="Add a caption… (optional)"
                        value={myStatus}
                        onChange={e => setMyStatus(e.target.value)}
                        style={{
                          width: '100%', boxSizing: 'border-box',
                          padding: '12px 48px 12px 16px',
                          background: '#1e2d38',
                          border: '1.5px solid rgba(134,150,160,0.15)',
                          borderRadius: 12, color: '#e9edef', fontSize: 14,
                          fontFamily: 'inherit', outline: 'none',
                        }}
                      />
                      <button
                        onClick={() => setStatusEmojiOpen(o => !o)}
                        style={{
                          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                          width: 30, height: 30, borderRadius: '50%',
                          background: statusEmojiOpen ? `${themeColor}33` : 'rgba(255,255,255,0.06)',
                          border: 'none', fontSize: 17, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        😊
                      </button>
                    </div>

                    {statusEmojiOpen && (
                      <div style={{ background: '#1e2d38', borderRadius: 12, border: '1px solid rgba(134,150,160,0.12)', padding: 10 }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {STATUS_EMOJIS.map(e => (
                            <button key={e} onClick={() => setMyStatus(t => t + e)}
                              style={{ width: 36, height: 36, background: 'rgba(255,255,255,0.04)', border: 'none', borderRadius: 8, fontSize: 19, cursor: 'pointer' }}>
                              {e}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Footer ── */}
              <div style={{ padding: '16px 18px 28px', display: 'flex', gap: 10, flexShrink: 0 }}>
                <button
                  onClick={() => { setShowStatusModal(false); setStatusPostType('text'); setStatusVideoFile(null); setStatusVideoUrl(null); setStatusVideoError(''); setMyStatus(''); setStatusEmojiOpen(false) }}
                  style={{
                    flex: 1, padding: '13px', background: '#1e2d38',
                    border: '1.5px solid rgba(134,150,160,0.15)',
                    borderRadius: 14, color: '#8696a0', cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                    transition: 'all 0.15s',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={postStatus}
                  disabled={!canPost}
                  style={{
                    flex: 2, padding: '13px',
                    background: canPost ? `linear-gradient(135deg, ${themeColor} 0%, #25d366 100%)` : '#2a3942',
                    border: 'none', borderRadius: 14,
                    color: canPost ? 'white' : '#8696a0',
                    cursor: canPost ? 'pointer' : 'default',
                    fontFamily: 'inherit', fontSize: 15, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    boxShadow: canPost ? `0 4px 18px ${themeColor}55` : 'none',
                    transition: 'all 0.2s',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="16"/>
                    <line x1="8" y1="12" x2="16" y2="12"/>
                  </svg>
                  Add to Status
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── SETTINGS PANEL ── */}
      {showSettings && (
        <div className="wa-call-modal" onClick={() => { setShowSettings(false); setSettingsPage(null); setShowSwitchAccountDropdown(false) }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', top: 0, left: 0, width: 'min(380px, 100vw)', height: '100%', background: dm.settingsBg, display: 'flex', flexDirection: 'column', zIndex: 300, boxShadow: '4px 0 24px rgba(0,0,0,0.45)' }}>

            {/* Header */}
            <div style={{ padding: '14px 16px', background: dm.header, display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${dm.border}`, flexShrink: 0 }}>
              <button onClick={() => { if (settingsPage) { setSettingsPage(null); setShowSwitchAccountDropdown(false) } else { setShowSettings(false) } }} style={{ background: 'none', border: 'none', color: dm.subtext, cursor: 'pointer', display: 'flex', padding: 4, borderRadius: 6 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <span style={{ color: dm.text, fontSize: 19, fontWeight: 700, letterSpacing: '-0.2px' }}>
                {settingsPage === 'account' ? 'Account' : settingsPage === 'chats' ? 'Chats' : settingsPage === 'notifications' ? 'Notifications' : settingsPage === 'privacy' ? 'Privacy' : settingsPage === 'help' ? 'Help' : settingsPage === 'devices' ? 'Linked Devices' : settingsPage === 'storage' ? 'Storage and Data' : 'Settings'}
              </span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', background: dm.settingsBg }}>
              {/* ── MAIN SETTINGS LIST ── */}
              {!settingsPage && (
                <div>
                  {/* Profile card */}
                  <div onClick={openAccountSettings} style={{ background: dm.panel, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer', transition: 'background 0.15s' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = dm.hover} onMouseLeave={(e) => e.currentTarget.style.background = dm.panel}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{ width: 62, height: 62, borderRadius: '50%', background: themeGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 24, overflow: 'hidden' }}>
                        {user.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : userInitial}
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: dm.text, fontSize: 17, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.display_name || user.username}</div>
                      <div style={{ color: dm.subtext, fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.about || 'Hey there! I am using SPVB.'}</div>
                      <div style={{ color: dm.subtext, fontSize: 11, marginTop: 3 }}>{user.phone || user.email}</div>
                    </div>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                  </div>

                  {/* ── Section 1: Core Settings ── */}
                  <div style={{ height: 8, background: dm.settingsBg }} />
                  {[
                    { key: 'account',       icon: '👤', color: '#5c9ded', label: 'Account',          sub: 'Security notifications, change number' },
                    { key: 'privacy',       icon: '🔒', color: '#25d366', label: 'Privacy',           sub: showLastSeen ? 'Last seen: everyone' : 'Last seen: nobody' },
                    { key: 'chats',         icon: '💬', color: '#fbbf24', label: 'Chats',             sub: 'Theme, wallpaper, chat history' },
                    { key: 'notifications', icon: '🔔', color: '#f97316', label: 'Notifications',     sub: notifEnabled ? (notifSound ? 'On · Sound on' : 'On · Silent') : 'Off' },
                    { key: 'storage',       icon: '📦', color: '#8b5cf6', label: 'Storage and Data',  sub: 'Network usage, auto-download' },
                    { key: 'devices',       icon: '📱', color: '#06b6d4', label: 'Linked Devices',    sub: 'Link another device via QR' },
                  ].map(({ key, icon, color, label, sub }, idx, arr) => (
                    <div key={key} onClick={() => key === 'account' ? openAccountSettings() : setSettingsPage(key)} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 20px', cursor: 'pointer', background: dm.panel, borderBottom: idx < arr.length - 1 ? `1px solid ${dm.border}` : 'none', transition: 'background 0.15s' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = dm.hover} onMouseLeave={(e) => e.currentTarget.style.background = dm.panel}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: `${color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>{icon}</div>
                      <div style={{ flex: 1 }}><div style={{ color: dm.text, fontSize: 15, fontWeight: 500 }}>{label}</div><div style={{ color: dm.subtext, fontSize: 12, marginTop: 1 }}>{sub}</div></div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  ))}

                  {/* ── Section 2: Integrations ── */}
                  <div style={{ height: 8, background: dm.settingsBg }} />
                  <div style={{ background: dm.panel }}>
                    {/* Gmail row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 20px', borderBottom: `1px solid ${dm.border}` }}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(66,133,244,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4285f4" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: dm.text, fontSize: 15, fontWeight: 500 }}>Gmail</div>
                        <div style={{ color: gmailToken ? '#25d366' : dm.subtext, fontSize: 12, marginTop: 1 }}>{gmailToken ? '● Connected · Read-only' : isGoogleUser() ? 'Auto-connected via Google' : 'Not connected'}</div>
                      </div>
                      {gmailToken && !isGoogleUser() ? (
                        <button onClick={() => { localStorage.removeItem('gmail_access_token'); localStorage.removeItem('gmail_token_expiry'); setGmailToken(null); setMails([]) }} style={{ padding: '6px 14px', background: 'rgba(234,84,85,0.12)', border: '1px solid rgba(234,84,85,0.3)', borderRadius: 20, color: '#ea5455', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 600 }}>Disconnect</button>
                      ) : !gmailToken && !isGoogleUser() ? (
                        <button onClick={() => { setShowSettings(false); setTab('mail'); connectGmail() }} style={{ padding: '6px 14px', background: '#4285f4', border: 'none', borderRadius: 20, color: 'white', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 600 }}>Connect</button>
                      ) : null}
                    </div>

                    {/* Help row */}
                    <div onClick={() => setSettingsPage('help')} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 20px', cursor: 'pointer', transition: 'background 0.15s' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = dm.hover} onMouseLeave={(e) => e.currentTarget.style.background = dm.panel}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(134,150,160,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>❓</div>
                      <div style={{ flex: 1 }}><div style={{ color: dm.text, fontSize: 15, fontWeight: 500 }}>Help</div><div style={{ color: dm.subtext, fontSize: 12, marginTop: 1 }}>FAQ, contact us, privacy policy</div></div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  </div>

                  {/* ── Section 3: Switch Account (inline dropdown) ── */}
                  <div style={{ height: 8, background: dm.settingsBg }} />
                  <div style={{ background: dm.panel }}>
                    <div onClick={() => { saveCurrentAccount(); setShowSwitchAccountDropdown(p => !p) }} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 20px', cursor: 'pointer', transition: 'background 0.15s' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = dm.hover} onMouseLeave={(e) => e.currentTarget.style.background = dm.panel}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: `${themeColor}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: dm.text, fontSize: 15, fontWeight: 500 }}>Switch Account</div>
                        <div style={{ color: dm.subtext, fontSize: 12, marginTop: 1 }}>
                          {savedAccounts.length > 1 ? `${savedAccounts.length} accounts saved` : 'Manage accounts'}
                        </div>
                      </div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2" style={{ transition: 'transform 0.2s', transform: showSwitchAccountDropdown ? 'rotate(90deg)' : 'none' }}><polyline points="9 18 15 12 9 6"/></svg>
                    </div>

                    {/* Inline account dropdown */}
                    {showSwitchAccountDropdown && (
                      <div style={{ background: dm.settingsBg, borderTop: `1px solid ${dm.border}` }}>
                        {/* Current account */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px 12px 28px', background: `${themeColor}09` }}>
                          <div style={{ position: 'relative', flexShrink: 0 }}>
                            <div style={{ width: 44, height: 44, borderRadius: '50%', background: themeGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 18, overflow: 'hidden', border: `2px solid ${themeColor}` }}>
                              {user?.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : userInitial}
                            </div>
                            <div style={{ position: 'absolute', bottom: 1, right: 1, width: 10, height: 10, borderRadius: '50%', background: '#25d366', border: `2px solid ${dm.settingsBg}` }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ color: dm.text, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.display_name || user?.username}</div>
                            <div style={{ color: dm.subtext, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</div>
                          </div>
                          <div style={{ padding: '3px 10px', background: `${themeColor}22`, borderRadius: 20, color: themeColor, fontSize: 11, fontWeight: 700 }}>Active</div>
                        </div>

                        {/* Other accounts */}
                        {savedAccounts.filter(a => String(a.id) !== String(user?.id)).map(acc => (
                          <div key={acc.id} style={{ display: 'flex', alignItems: 'center', borderTop: `1px solid ${dm.border}` }}>
                            <button onClick={() => { setShowSwitchAccountDropdown(false); setShowSettings(false); switchAccount(acc) }} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px 12px 28px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s' }}
                              onMouseEnter={e => e.currentTarget.style.background = dm.hover} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                              <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', color: dm.text, fontWeight: 700, fontSize: 18, overflow: 'hidden', flexShrink: 0 }}>
                                {acc.avatar_url ? <img src={acc.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (acc.display_name || acc.username || 'U')[0].toUpperCase()}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: dm.text, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.display_name || acc.username}</div>
                                <div style={{ color: dm.subtext, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.email}</div>
                              </div>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                            </button>
                            <button onClick={() => removeAccount(acc.id)} style={{ background: 'none', border: 'none', color: dm.subtext, cursor: 'pointer', padding: '12px 16px 12px 4px', display: 'flex', opacity: 0.7 }} title="Remove">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                          </div>
                        ))}

                        {/* Add account */}
                        <button onClick={() => { setShowSwitchAccountDropdown(false); addNewAccount() }} style={{ width: '100%', padding: '13px 20px 13px 28px', background: 'none', border: 'none', borderTop: `1px solid ${dm.border}`, color: themeColor, cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14, fontWeight: 600, transition: 'background 0.15s' }}
                          onMouseEnter={e => e.currentTarget.style.background = dm.hover} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                          <div style={{ width: 44, height: 44, borderRadius: '50%', border: `2px dashed ${themeColor}55`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                          </div>
                          Add Account
                        </button>
                      </div>
                    )}

                    {/* Log out */}
                    <div onClick={logout} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 20px', cursor: 'pointer', borderTop: `1px solid ${dm.border}`, transition: 'background 0.15s' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#2a1c1c'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(234,84,85,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ea5455" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                      </div>
                      <span style={{ color: '#ea5455', fontSize: 15, fontWeight: 500 }}>Log out</span>
                    </div>
                  </div>

                  {/* App version footer */}
                  <div style={{ padding: '20px', textAlign: 'center' }}>
                    <div style={{ color: dm.subtext, fontSize: 12 }}>SPVB v1.3.0</div>
                    <div style={{ color: dm.subtext, fontSize: 11, marginTop: 3, opacity: 0.6 }}>Smart Private Video Bridge · © 2026</div>
                  </div>
                </div>
              )}

              {/* Account sub-page */}
              {settingsPage === 'account' && (
                <div>
                  {/* Cover photo + avatar overlay */}
                  <div style={{ position: 'relative', height: 130, background: user.cover_url ? 'transparent' : `linear-gradient(135deg, ${themeColor}55, #1a2c35)`, flexShrink: 0 }}>
                    {user.cover_url && <img src={user.cover_url} alt="cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                    {/* Cover loading overlay */}
                    {coverUploading && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                        <div style={{ width: 28, height: 28, border: `3px solid rgba(255,255,255,0.3)`, borderTop: `3px solid white`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                        <span style={{ color: 'white', fontSize: 11 }}>Uploading cover…</span>
                      </div>
                    )}
                    {!coverUploading && (
                      <label style={{ position: 'absolute', bottom: 8, right: 10, display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(0,0,0,0.55)', borderRadius: 16, padding: '5px 10px', cursor: 'pointer', color: 'white', fontSize: 12 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                        Cover photo
                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCover(f); e.target.value = '' }} />
                      </label>
                    )}
                    <label style={{ position: 'absolute', bottom: -30, left: '50%', transform: 'translateX(-50%)', width: 68, height: 68, cursor: avatarUploading ? 'default' : 'pointer', display: 'block' }}>
                      <div style={{ width: 68, height: 68, borderRadius: '50%', border: '3px solid #111b21', background: themeGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 26, overflow: 'hidden', position: 'relative' }}>
                        {user.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : userInitial}
                        {avatarUploading && (
                          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%' }}>
                            <div style={{ width: 22, height: 22, border: `3px solid rgba(255,255,255,0.3)`, borderTop: `3px solid white`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                          </div>
                        )}
                      </div>
                      {!avatarUploading && (
                        <div style={{ position: 'absolute', bottom: 0, right: 0, background: themeColor, borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #111b21' }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                        </div>
                      )}
                      <input type="file" accept="image/*" style={{ display: 'none' }} disabled={avatarUploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); e.target.value = '' }} />
                    </label>
                  </div>
                  <div style={{ padding: '44px 20px 20px' }}>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ color: dm.subtext, fontSize: 12, display: 'block', marginBottom: 6 }}>Display Name <span style={{ color: themeColor, fontSize: 11 }}>(editable anytime)</span></label>
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={50} style={{ width: '100%', padding: '10px 14px', background: dm.input, border: `1px solid ${themeColor}40`, borderRadius: 8, color: dm.text, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ color: dm.subtext, fontSize: 12, display: 'block', marginBottom: 6 }}>About</label>
                    <input value={editAbout} onChange={(e) => setEditAbout(e.target.value)} maxLength={140} placeholder="Hey there! I am using SPVB." style={{ width: '100%', padding: '10px 14px', background: dm.input, border: `1px solid ${dm.border}`, borderRadius: 8, color: dm.text, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
                    <div style={{ color: dm.subtext, fontSize: 11, textAlign: 'right', marginTop: 4 }}>{editAbout.length}/140</div>
                  </div>
                  {/* Locked fields */}
                  <div style={{ marginBottom: 8, padding: '10px 14px', background: dm.panel, borderRadius: 8, border: `1px solid ${dm.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ color: dm.subtext, fontSize: 11, marginBottom: 1 }}>📱 Phone Number <span style={{ color: '#ea5455', fontSize: 10 }}>locked</span></div>
                      <div style={{ color: dm.text, fontSize: 14 }}>{user.phone || '—'}</div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  </div>
                  <div style={{ marginBottom: 16, padding: '10px 14px', background: dm.panel, borderRadius: 8, border: `1px solid ${dm.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ color: dm.subtext, fontSize: 11, marginBottom: 1 }}>✉️ Email <span style={{ color: '#ea5455', fontSize: 10 }}>locked</span></div>
                      <div style={{ color: dm.text, fontSize: 14 }}>{user.email}</div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  </div>
                  {/* Message Retention */}
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ color: '#8696a0', fontSize: 12, display: 'block', marginBottom: 6 }}>Message Auto-Delete</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                      {[{v:1,l:'1 Day'},{v:3,l:'3 Days'},{v:7,l:'7 Days'},{v:14,l:'14 Days'},{v:30,l:'30 Days'},{v:0,l:'Never'}].map(({v,l}) => (
                        <button key={v} onClick={() => setEditRetention(v)}
                          style={{ padding: '9px 6px', borderRadius: 8, border: editRetention === v ? `2px solid ${themeColor}` : '1px solid rgba(134,150,160,0.2)', background: editRetention === v ? `${themeColor}22` : '#2a3942', color: editRetention === v ? themeColor : '#8696a0', fontSize: 12, fontWeight: editRetention === v ? 700 : 400, cursor: 'pointer', fontFamily: 'inherit' }}>
                          {l}
                        </button>
                      ))}
                    </div>
                    <div style={{ color: '#8696a0', fontSize: 11, marginTop: 6 }}>
                      {editRetention === 0 ? 'Messages will never be auto-deleted.' : `Messages older than ${editRetention} day${editRetention > 1 ? 's' : ''} will be automatically deleted.`}
                    </div>
                  </div>
                  <button onClick={() => saveProfile()} disabled={editSaving} style={{ width: '100%', padding: '12px', background: themeGradient, border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit', opacity: editSaving ? 0.7 : 1, marginBottom: 8 }}>
                    {editSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                  {editSaveMsg && (
                    <div style={{ textAlign: 'center', fontSize: 13, marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: editSaveMsg.ok ? 'rgba(37,211,102,0.12)' : 'rgba(234,67,53,0.12)', color: editSaveMsg.ok ? '#25d366' : '#ea4335', border: `1px solid ${editSaveMsg.ok ? 'rgba(37,211,102,0.3)' : 'rgba(234,67,53,0.3)'}` }}>
                      {editSaveMsg.ok ? '✓ ' : '✕ '}{editSaveMsg.text}
                    </div>
                  )}
                  {/* Delete account */}
                  <div style={{ borderTop: `1px solid ${dm.border}`, paddingTop: 16, marginTop: 4 }}>
                    <div style={{ color: dm.subtext, fontSize: 12, marginBottom: 10, textAlign: 'center' }}>Danger Zone</div>
                    <button
                      onClick={async () => {
                        const confirmed = window.confirm('⚠️ Delete your account permanently?\n\nThis will delete all your messages, contacts, and data. This cannot be undone.')
                        if (!confirmed) return
                        const second = window.confirm('Are you absolutely sure? This is irreversible.')
                        if (!second) return
                        try {
                          const token = localStorage.getItem('token')
                          await fetch(apiUrl(`/api/users/${user.id}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
                        } catch {}
                        localStorage.clear()
                        window.location.href = '/login'
                      }}
                      style={{ width: '100%', padding: '11px', background: 'rgba(234,84,85,0.1)', border: '1.5px solid rgba(234,84,85,0.4)', borderRadius: 10, color: '#ea5455', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit' }}
                    >
                      🗑️ Delete My Account
                    </button>
                    <div style={{ color: dm.subtext, fontSize: 11, textAlign: 'center', marginTop: 6 }}>This permanently deletes all your data</div>
                  </div>

                  </div>
                </div>
              )}

              {/* Chats sub-page */}
              {settingsPage === 'chats' && (
                <div style={{ padding: 20, overflowY: 'auto', background: dm.settingsBg }}>
                  {/* Dark / Light mode */}
                  <div style={{ color: '#8696a0', fontSize: 12, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Appearance</div>
                  <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
                    {[{ id: true, label: '🌙 Dark', desc: 'Dark mode' }, { id: false, label: '☀️ Light', desc: 'Light mode' }].map(m => (
                      <div key={String(m.id)} onClick={() => { setDarkMode(m.id); localStorage.setItem('dark_mode', m.id ? 'dark' : 'light') }}
                        style={{ flex: 1, padding: '12px', borderRadius: 12, border: `2px solid ${darkMode === m.id ? themeColor : 'rgba(134,150,160,0.2)'}`, cursor: 'pointer', textAlign: 'center', background: darkMode === m.id ? `${themeColor}15` : 'transparent', transition: 'all 0.2s' }}>
                        <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 600 }}>{m.label}</div>
                        <div style={{ color: '#8696a0', fontSize: 11, marginTop: 2 }}>{m.desc}</div>
                      </div>
                    ))}
                  </div>

                  {/* Font style */}
                  <div style={{ color: '#8696a0', fontSize: 12, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Font Style</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                    {APP_FONTS.map(f => (
                      <div key={f.id} onClick={() => { setAppFont(f.id); localStorage.setItem('app_font', f.id) }}
                        style={{ padding: '8px 16px', borderRadius: 20, border: `2px solid ${appFont === f.id ? themeColor : 'rgba(134,150,160,0.2)'}`, cursor: 'pointer', background: appFont === f.id ? `${themeColor}15` : 'transparent', fontFamily: f.family, transition: 'all 0.2s' }}>
                        <span style={{ color: appFont === f.id ? themeColor : '#e9edef', fontSize: 13, fontWeight: 500 }}>{f.label}</span>
                      </div>
                    ))}
                  </div>

                  {/* Accent color */}
                  <div style={{ color: '#8696a0', fontSize: 12, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Accent Color</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
                    {Object.entries(THEMES).map(([key, color]) => (
                      <div key={key} onClick={() => { setChatTheme(key); localStorage.setItem('chat_theme', key) }}
                        style={{ width: 36, height: 36, borderRadius: '50%', background: color, cursor: 'pointer', border: `3px solid ${chatTheme === key ? '#fff' : 'transparent'}`, boxShadow: chatTheme === key ? `0 0 0 3px ${color}` : 'none', transition: 'all 0.2s', position: 'relative' }}>
                        {chatTheme === key && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14 }}>✓</span>}
                      </div>
                    ))}
                  </div>

                  {/* Premium gradient themes */}
                  <div style={{ color: '#8696a0', fontSize: 12, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>✨ Premium Themes</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
                    {PREMIUM_THEMES.map(pt => (
                      <div key={pt.id} onClick={() => { setChatTheme(pt.id); localStorage.setItem('chat_theme', pt.id) }}
                        style={{ borderRadius: 14, overflow: 'hidden', cursor: 'pointer', border: `2px solid ${chatTheme === pt.id ? pt.accent : 'rgba(134,150,160,0.15)'}`, transition: 'all 0.2s' }}>
                        <div style={{ height: 56, background: pt.gradient }} />
                        <div style={{ padding: '8px 10px', background: '#1a2530', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: pt.accent, flexShrink: 0 }} />
                          <span style={{ color: '#e9edef', fontSize: 12, fontWeight: 500 }}>{pt.label}</span>
                          {chatTheme === pt.id && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={pt.accent} strokeWidth="2.5" style={{ marginLeft: 'auto' }}><polyline points="20 6 9 17 4 12"/></svg>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Notifications sub-page */}
              {settingsPage === 'notifications' && (
                <div style={{ padding: '8px 0', background: dm.settingsBg }}>
                  {/* Messages section */}
                  <div style={{ margin: '8px 16px 6px', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Messages</div>
                  <div style={{ background: dm.panel }}>
                    {[
                      { label: 'Message Notifications', sub: 'Show notification for new messages', val: notifEnabled, set: (v) => { setNotifEnabled(v); localStorage.setItem('notif_enabled', v ? 'on' : 'off') } },
                      { label: 'Notification Sound', sub: 'Play sound for new messages', val: notifSound, set: (v) => { setNotifSound(v); localStorage.setItem('notif_sound', v ? 'on' : 'off') } },
                      { label: 'In-App Notifications', sub: 'Show banner inside the app', val: localStorage.getItem('notif_inapp') !== 'off', set: (v) => localStorage.setItem('notif_inapp', v ? 'on' : 'off') },
                      { label: 'Notification Preview', sub: 'Show message text in notifications', val: localStorage.getItem('notif_preview') !== 'off', set: (v) => localStorage.setItem('notif_preview', v ? 'on' : 'off') },
                    ].map(({ label, sub, val, set }, idx, arr) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: idx < arr.length - 1 ? `1px solid ${dm.border}` : 'none' }}>
                        <div style={{ flex: 1 }}><div style={{ color: dm.text, fontSize: 14, fontWeight: 500 }}>{label}</div><div style={{ color: dm.subtext, fontSize: 12, marginTop: 1 }}>{sub}</div></div>
                        <div onClick={() => set(!val)} style={{ width: 46, height: 26, background: val ? themeColor : '#2a3942', borderRadius: 13, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                          <div style={{ position: 'absolute', top: 3, left: val ? 22 : 3, width: 20, height: 20, background: 'white', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Single hidden file input for ringtone uploads */}
                  <input id="ringtone-upload-input" type="file" accept="audio/*" style={{ display: 'none' }} onChange={(e) => {
                    const f = e.target.files?.[0]; if (!f) return
                    const reader = new FileReader()
                    reader.onload = (ev) => {
                      // Stop any existing preview
                      if (previewAudioRef.current) { try { previewAudioRef.current.pause() } catch {}; previewAudioRef.current = null }
                      setPendingRingtoneUpload({ dataUrl: ev.target.result, fileName: f.name.replace(/\.[^.]+$/, '') })
                    }
                    reader.readAsDataURL(f)
                    e.target.value = ''
                  }} />

                  {/* Message Ringtone picker */}
                  <div style={{ margin: '16px 16px 6px', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Message Ringtone</div>
                  <div style={{ background: dm.panel, padding: '14px 16px' }}>
                    <div style={{ color: dm.subtext, fontSize: 12, marginBottom: 10 }}>Default sound for new messages (overridden by per-contact ringtone)</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                      {RINGTONES.map(rt => {
                        const selected = msgRingtone === rt.id
                        const hasCustom = rt.isCustom && localStorage.getItem(rt.storageKey)
                        return (
                          <div key={rt.id} style={{ position: 'relative' }}>
                            <div onClick={() => {
                              if (rt.isCustom && !hasCustom) { document.getElementById('ringtone-upload-input').click(); return }
                              setMsgRingtone(rt.id); localStorage.setItem('msg_ringtone', rt.id)
                              if (rt.id !== 'none') {
                                if (previewAudioRef.current) { try { previewAudioRef.current.pause() } catch {}; previewAudioRef.current = null }
                                if (rt.id === 'custom_msg') {
                                  const dataUrl = localStorage.getItem('custom_msg_ringtone_data')
                                  if (dataUrl) { try { const a = new Audio(dataUrl); a.volume = 0.8; previewAudioRef.current = a; a.play().catch(() => {}) } catch {} }
                                } else { playRingtone(rt.id) }
                              }
                            }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: selected ? `${themeColor}18` : dm.input, border: `1.5px solid ${selected ? themeColor : 'rgba(134,150,160,0.15)'}`, borderRadius: 10, cursor: 'pointer', transition: 'all 0.15s' }}>
                              <span style={{ fontSize: 18 }}>{rt.emoji}</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: selected ? themeColor : dm.text, fontSize: 13, fontWeight: selected ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hasCustom ? (localStorage.getItem('custom_msg_ringtone_name') || rt.label) : rt.label}</div>
                                <div style={{ color: dm.subtext, fontSize: 10 }}>{rt.isCustom ? (hasCustom ? 'Tap to play · Upload to change' : 'Tap to upload') : rt.desc}</div>
                              </div>
                              {selected && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="3" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>}
                            </div>
                            {rt.isCustom && hasCustom && (
                              <div onClick={() => document.getElementById('ringtone-upload-input').click()} style={{ position: 'absolute', top: 6, right: 6, background: themeColor, borderRadius: 6, padding: '3px 7px', fontSize: 10, color: 'white', cursor: 'pointer', fontWeight: 600 }}>↑ Change</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Call Ringtone picker */}
                  <div style={{ margin: '16px 16px 6px', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Incoming Call Ringtone</div>
                  <div style={{ background: dm.panel, padding: '14px 16px' }}>
                    <div style={{ color: dm.subtext, fontSize: 12, marginBottom: 10 }}>Sound that plays when someone calls you</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                      {CALL_RINGTONES.map(rt => {
                        const selected = callRingtone === rt.id
                        const hasCustom = rt.isCustom && localStorage.getItem(rt.storageKey)
                        return (
                          <div key={rt.id} style={{ position: 'relative' }}>
                            <div onClick={() => {
                              if (rt.isCustom && !hasCustom) { document.getElementById('ringtone-upload-input').click(); return }
                              setCallRingtone(rt.id); localStorage.setItem('call_ringtone', rt.id)
                              if (rt.id !== 'none' && rt.id !== 'call') {
                                if (previewAudioRef.current) { try { previewAudioRef.current.pause() } catch {}; previewAudioRef.current = null }
                                if (rt.id === 'custom_call') {
                                  const dataUrl = localStorage.getItem('custom_call_ringtone_data')
                                  if (dataUrl) { try { const a = new Audio(dataUrl); a.volume = 0.85; previewAudioRef.current = a; a.play().catch(() => {}) } catch {} }
                                } else { playRingtone(rt.id) }
                              }
                            }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: selected ? `${themeColor}18` : dm.input, border: `1.5px solid ${selected ? themeColor : 'rgba(134,150,160,0.15)'}`, borderRadius: 10, cursor: 'pointer', transition: 'all 0.15s' }}>
                              <span style={{ fontSize: 18 }}>{rt.emoji}</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ color: selected ? themeColor : dm.text, fontSize: 13, fontWeight: selected ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hasCustom ? (localStorage.getItem('custom_call_ringtone_name') || rt.label) : rt.label}</div>
                                <div style={{ color: dm.subtext, fontSize: 10 }}>{rt.isCustom ? (hasCustom ? 'Tap to preview · Upload to change' : 'Tap to upload') : rt.desc}</div>
                              </div>
                              {selected && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="3" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>}
                            </div>
                            {rt.isCustom && hasCustom && (
                              <div onClick={() => document.getElementById('ringtone-upload-input').click()} style={{ position: 'absolute', top: 6, right: 6, background: themeColor, borderRadius: 6, padding: '3px 7px', fontSize: 10, color: 'white', cursor: 'pointer', fontWeight: 600 }}>↑ Change</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Groups section */}
                  <div style={{ margin: '16px 16px 6px', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Groups</div>
                  <div style={{ background: dm.panel }}>
                    {[
                      { label: 'Group Notifications', sub: 'Show notification for group messages', val: localStorage.getItem('notif_groups') !== 'off', set: (v) => localStorage.setItem('notif_groups', v ? 'on' : 'off') },
                      { label: 'Group Sound', sub: 'Play sound for group messages', val: localStorage.getItem('notif_groups_sound') !== 'off', set: (v) => localStorage.setItem('notif_groups_sound', v ? 'on' : 'off') },
                    ].map(({ label, sub, val, set }, idx, arr) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: idx < arr.length - 1 ? `1px solid ${dm.border}` : 'none' }}>
                        <div style={{ flex: 1 }}><div style={{ color: dm.text, fontSize: 14, fontWeight: 500 }}>{label}</div><div style={{ color: dm.subtext, fontSize: 12, marginTop: 1 }}>{sub}</div></div>
                        <div onClick={() => set(!val)} style={{ width: 46, height: 26, background: val ? themeColor : '#2a3942', borderRadius: 13, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                          <div style={{ position: 'absolute', top: 3, left: val ? 22 : 3, width: 20, height: 20, background: 'white', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Push notification status + test */}
                  <div style={{ margin: '16px 16px 0', padding: 16, background: dm.panel, borderRadius: 14, border: `1px solid ${dm.border}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: Notification.permission === 'granted' ? '#25d366' : '#f39c12', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ color: dm.text, fontSize: 13, fontWeight: 600 }}>
                          {Notification.permission === 'granted' ? 'Push notifications allowed' : Notification.permission === 'denied' ? 'Push notifications blocked' : 'Push permission not granted'}
                        </div>
                        <div style={{ color: dm.subtext, fontSize: 11, marginTop: 2 }}>
                          {Notification.permission === 'denied' ? 'Enable in browser: Site Settings → Notifications' : Notification.permission === 'granted' ? 'Background push active on HTTPS' : 'Click below to request permission'}
                        </div>
                      </div>
                      {Notification.permission !== 'granted' && (
                        <button onClick={async () => {
                          // Request permission (requires user gesture — this button IS the gesture)
                          const perm = await Notification.requestPermission()
                          if (perm === 'granted') {
                            // Immediately run full push setup now that we have permission
                            const token = localStorage.getItem('token')
                            if (!token) return
                            try {
                              const { initFirebase, getFCMToken } = await import('../firebase.js')
                              const msg = initFirebase()
                              if (msg) {
                                await navigator.serviceWorker.register('/firebase-messaging-sw.js')
                                await navigator.serviceWorker.ready
                                const fcmToken = await getFCMToken()
                                if (fcmToken) {
                                  await fetch(apiUrl('/api/push/fcm-token'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ token: fcmToken }) })
                                  localStorage.setItem('fcm_token', fcmToken)
                                }
                              }
                            } catch {}
                          }
                          // Force re-render to update the permission status display
                          setNotifEnabled(prev => prev)
                        }} style={{ padding: '7px 14px', background: themeColor, border: 'none', borderRadius: 20, color: 'white', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 600, flexShrink: 0 }}>Allow</button>
                      )}
                    </div>
                    <button onClick={async () => {
                      const token = localStorage.getItem('token')
                      try {
                        const res = await fetch(apiUrl('/api/push/test'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
                        const d = await res.json()
                        if (d.subscriptions === 0) alert('No push subscription found.\nAllow notifications above, then re-open the app.')
                        else alert(`✓ Test push sent to ${d.subscriptions} subscription(s). Check your notification bar!`)
                      } catch { alert('Could not reach push service.') }
                    }} style={{ padding: '11px 0', background: themeGradient, border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit' }}>
                      🔔 Send Test Notification
                    </button>
                  </div>
                  <div style={{ height: 20 }} />
                </div>
              )}

              {/* Privacy sub-page */}
              {settingsPage === 'privacy' && (
                <div style={{ padding: '8px 0', background: dm.settingsBg }}>
                  {/* Who can see */}
                  <div style={{ margin: '8px 16px 6px', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Who can see</div>
                  <div style={{ background: dm.panel }}>
                    {[
                      { label: 'Last Seen', sub: showLastSeen ? 'Everyone' : 'Nobody', val: showLastSeen, set: (v) => { setShowLastSeen(v); localStorage.setItem('show_last_seen', v ? 'on' : 'off') } },
                      { label: 'Read Receipts', sub: readReceipts ? 'Contacts see double-tick reads' : 'Disabled', val: readReceipts, set: (v) => { setReadReceipts(v); localStorage.setItem('read_receipts', v ? 'on' : 'off') } },
                      { label: 'Online Status', sub: showOnlineStatus ? 'Visible to contacts' : 'Hidden', val: showOnlineStatus, set: (v) => { setShowOnlineStatus(v); localStorage.setItem('show_online_status', v ? 'on' : 'off') } },
                    ].map(({ label, sub, val, set }, idx, arr) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: idx < arr.length - 1 ? `1px solid ${dm.border}` : 'none' }}>
                        <div style={{ flex: 1 }}><div style={{ color: dm.text, fontSize: 14, fontWeight: 500 }}>{label}</div><div style={{ color: dm.subtext, fontSize: 12, marginTop: 1 }}>{sub}</div></div>
                        <div onClick={() => set(!val)} style={{ width: 46, height: 26, background: val ? themeColor : '#2a3942', borderRadius: 13, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                          <div style={{ position: 'absolute', top: 3, left: val ? 22 : 3, width: 20, height: 20, background: 'white', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* App Lock / Biometric */}
                  <div style={{ margin: '16px 16px 6px', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>App Lock</div>
                  <div style={{ background: dm.panel, borderRadius: 0 }}>
                    <div style={{ padding: '16px 20px', borderBottom: `1px solid ${dm.border}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
                        <div style={{ width: 44, height: 44, borderRadius: 12, background: `${themeColor}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ color: dm.text, fontSize: 14, fontWeight: 600 }}>Biometric App Lock</div>
                          <div style={{ color: dm.subtext, fontSize: 12, marginTop: 2 }}>
                            {hasBiometricRegistered() ? '✓ Active · fingerprint / Face ID / Windows Hello' : 'Protect the app with your device biometrics'}
                          </div>
                        </div>
                      </div>
                      {hasBiometricRegistered() ? (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <div style={{ flex: 1, padding: '9px 12px', background: `${themeColor}15`, borderRadius: 10, color: themeColor, fontSize: 12, textAlign: 'center', fontWeight: 600 }}>🔒 Locks after 5 min idle</div>
                          <button onClick={() => { if (window.confirm('Remove biometric lock?')) { import('../utils/biometric').then(m => { m.clearBiometricRegistration(); window.location.reload() }) } }}
                            style={{ padding: '9px 16px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 10, color: '#ef4444', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Remove</button>
                        </div>
                      ) : (
                        <button onClick={() => { if (onRegisterBiometric) onRegisterBiometric() }}
                          style={{ width: '100%', padding: '11px', background: themeGradient, border: 'none', borderRadius: 10, color: 'white', fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                          Enable Biometric Lock
                        </button>
                      )}
                    </div>
                    <div style={{ padding: '12px 20px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      <div style={{ color: dm.subtext, fontSize: 12, lineHeight: 1.5 }}>Biometric data never leaves your device. SPVB uses your secure hardware for authentication.</div>
                    </div>
                  </div>
                  <div style={{ height: 20 }} />
                </div>
              )}

              {/* Linked Devices sub-page */}
              {settingsPage === 'devices' && (() => {
                if (showQrPanel) {
                  return (
                    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div style={{ textAlign: 'center', color: '#8696a0', fontSize: 13, lineHeight: 1.6 }}>
                        Scan this QR code from another device logged into <b style={{ color: '#e9edef' }}>the same account</b> to link it.
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                        {qrStatus === 'idle' && (
                          <button onClick={generateQrCode} style={{ padding: '12px 28px', background: themeGradient, border: 'none', borderRadius: 12, color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit' }}>
                            Generate QR Code
                          </button>
                        )}
                        {qrStatus === 'generating' && (
                          <div style={{ width: 32, height: 32, border: `3px solid ${themeColor}33`, borderTopColor: themeColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                        )}
                        {(qrStatus === 'ready' || qrStatus === 'scanned') && qrDataUrl && (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                            <div style={{ padding: 10, background: 'white', borderRadius: 14, boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
                              <img src={qrDataUrl} alt="QR Code" style={{ width: 200, height: 200, display: 'block' }} />
                            </div>
                            {qrStatus === 'scanned' ? (
                              <div style={{ color: themeColor, fontSize: 13, fontWeight: 600 }}>QR scanned — waiting for you to approve on the other device…</div>
                            ) : (
                              <div style={{ color: '#8696a0', fontSize: 12 }}>Valid for 10 minutes · Open this link in another browser</div>
                            )}
                          </div>
                        )}
                        {qrStatus === 'approved' && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
                            <div style={{ color: themeColor, fontWeight: 600 }}>Device linked successfully!</div>
                          </div>
                        )}
                        {qrStatus === 'rejected' && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 40, marginBottom: 8 }}>❌</div>
                            <div style={{ color: '#ea5455', fontWeight: 600 }}>Request was rejected.</div>
                          </div>
                        )}
                        {qrStatus === 'expired' && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ color: '#8696a0', fontSize: 13, marginBottom: 10 }}>QR code expired.</div>
                            <button onClick={() => { setQrStatus('idle'); setQrToken(null); setQrDataUrl(null) }} style={{ padding: '10px 20px', background: themeGradient, border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                              Generate New
                            </button>
                          </div>
                        )}
                      </div>
                      <button onClick={() => setShowQrPanel(false)} style={{ padding: '10px', background: '#2a3942', border: 'none', borderRadius: 10, color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>Back</button>
                    </div>
                  )
                }
                return (
                  <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

                    {/* QR Scanner modal overlay */}
                    {showQrScanner && (
                      <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                        {qrScanStatus === 'scanning' && (
                          <>
                            <div style={{ position: 'relative', width: '100%', maxWidth: 400, aspectRatio: '1', background: '#000' }}>
                              <video ref={qrVideoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              {/* Scan frame overlay */}
                              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                                <div style={{ width: 220, height: 220, position: 'relative' }}>
                                  {[{top:0,left:0},{top:0,right:0},{bottom:0,left:0},{bottom:0,right:0}].map((pos, i) => (
                                    <div key={i} style={{ position: 'absolute', width: 36, height: 36, borderColor: themeColor, borderStyle: 'solid', borderWidth: 0, ...( i===0?{borderTopWidth:4,borderLeftWidth:4,borderRadius:'8px 0 0 0'}: i===1?{borderTopWidth:4,borderRightWidth:4,borderRadius:'0 8px 0 0'}: i===2?{borderBottomWidth:4,borderLeftWidth:4,borderRadius:'0 0 0 8px'}: {borderBottomWidth:4,borderRightWidth:4,borderRadius:'0 0 8px 0'}), ...pos }} />
                                  ))}
                                  <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 2, background: `${themeColor}88`, animation: 'scanLine 2s ease-in-out infinite' }} />
                                </div>
                              </div>
                            </div>
                            <p style={{ color: '#fff', marginTop: 24, fontSize: 15, textAlign: 'center', padding: '0 24px' }}>Point camera at the QR code on SPVB Web</p>
                            {qrScanError === 'AUTO_SCAN_UNSUPPORTED' && (
                              <p style={{ color: '#f59e0b', fontSize: 13, textAlign: 'center', padding: '0 24px', marginTop: 8 }}>
                                Auto-detect not supported on this browser.<br/>Use your phone's camera app to scan instead.
                              </p>
                            )}
                          </>
                        )}
                        {qrScanStatus === 'approving' && (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, color: '#fff' }}>
                            <div style={{ width: 44, height: 44, border: `3px solid ${themeColor}44`, borderTopColor: themeColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                            <p>Approving desktop login…</p>
                          </div>
                        )}
                        {qrScanStatus === 'done' && (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, color: '#fff' }}>
                            <div style={{ fontSize: 64 }}>✅</div>
                            <p style={{ fontSize: 18, fontWeight: 700, color: themeColor }}>Desktop linked!</p>
                            <p style={{ color: '#8696a0', fontSize: 13 }}>The desktop browser is now logged in.</p>
                          </div>
                        )}
                        {qrScanStatus === 'error' && (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, color: '#fff', padding: '0 24px', textAlign: 'center' }}>
                            <div style={{ fontSize: 56 }}>❌</div>
                            <p style={{ color: '#ef4444', fontSize: 15 }}>{qrScanError}</p>
                          </div>
                        )}
                        <button onClick={stopQrScanner} style={{ marginTop: 32, padding: '12px 32px', background: '#2a3942', border: 'none', borderRadius: 12, color: '#e9edef', cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, fontWeight: 600 }}>
                          {qrScanStatus === 'done' ? 'Close' : 'Cancel'}
                        </button>
                        <style>{`@keyframes scanLine { 0%,100%{top:10%} 50%{top:90%} }`}</style>
                      </div>
                    )}

                    {/* Scan QR (mobile → approve desktop login) */}
                    <div style={{ padding: 16, background: '#202c33', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: `${themeColor}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 600 }}>Scan QR Code</div>
                        <div style={{ color: '#8696a0', fontSize: 12, marginTop: 2 }}>Scan the QR on SPVB Web to log in that browser</div>
                      </div>
                      <button onClick={startQrScanner} style={{ padding: '8px 14px', background: themeGradient, border: 'none', borderRadius: 8, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>
                        Scan
                      </button>
                    </div>

                    {/* Link a Device (generate QR for same-account multi-device) */}
                    <div style={{ padding: 16, background: '#202c33', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#2a394222', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8696a0" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: '#e9edef', fontSize: 14, fontWeight: 600 }}>Link a Device</div>
                        <div style={{ color: '#8696a0', fontSize: 12, marginTop: 2 }}>Show QR for another device on this account to scan</div>
                      </div>
                      <button onClick={() => { setShowQrPanel(true); setQrStatus('idle'); setQrToken(null); setQrDataUrl(null) }} style={{ padding: '8px 14px', background: '#2a3942', border: '1px solid #374151', borderRadius: 8, color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>
                        Link
                      </button>
                    </div>
                    <div style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Active Sessions ({linkedDevices.length})
                    </div>
                    {linkedDevices.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '24px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4a5568" strokeWidth="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                        <div style={{ color: '#8696a0', fontSize: 13 }}>No active sessions</div>
                        <div style={{ color: '#4a5568', fontSize: 11 }}>Log in on another device to see it here</div>
                      </div>
                    ) : linkedDevices.map(d => {
                      const isMobile = d.device_type === 'mobile'
                      const isTablet = d.device_type === 'tablet'
                      const loginDate = d.created_at ? new Date(d.created_at.endsWith('Z') ? d.created_at : d.created_at + 'Z').toLocaleString() : '—'
                      const lastSeen = d.last_seen ? new Date(d.last_seen.endsWith('Z') ? d.last_seen : d.last_seen + 'Z').toLocaleString() : '—'
                      const loginMethodLabel = d.login_method === 'google' ? 'Google' : d.login_method === 'qr' ? 'QR Code' : 'Password'
                      return (
                        <div key={d.id} style={{ background: '#202c33', borderRadius: 12, overflow: 'hidden', border: d.is_current ? `1px solid ${themeColor}55` : '1px solid rgba(134,150,160,0.1)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                            {isMobile ? (
                              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="1.8"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
                            ) : isTablet ? (
                              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="1.8"><rect x="3" y="2" width="18" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
                            ) : (
                              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="1.8"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span style={{ color: '#e9edef', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.device_name || 'Unknown Device'}</span>
                                {d.is_current && (
                                  <span style={{ background: `${themeColor}22`, color: themeColor, fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 6, border: `1px solid ${themeColor}44`, whiteSpace: 'nowrap' }}>This device</span>
                                )}
                              </div>
                              <div style={{ color: '#8696a0', fontSize: 11, marginTop: 2 }}>
                                {[d.os, d.browser].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                            {!d.is_current && (
                              <button onClick={() => removeLinkedDevice(d.id)} style={{ background: 'rgba(234,84,85,0.1)', border: '1px solid rgba(234,84,85,0.25)', borderRadius: 8, padding: '6px 12px', color: '#ea5455', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 600, flexShrink: 0 }}>Remove</button>
                            )}
                          </div>
                          <div style={{ padding: '8px 14px 12px', borderTop: '1px solid rgba(134,150,160,0.08)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            {d.ip && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ color: '#4a5568', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>IP Address</span>
                                <span style={{ color: '#8696a0', fontSize: 11, fontFamily: 'monospace' }}>{d.ip}</span>
                              </div>
                            )}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ color: '#4a5568', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Signed In</span>
                              <span style={{ color: '#8696a0', fontSize: 11 }}>{loginDate}</span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ color: '#4a5568', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Last Active</span>
                              <span style={{ color: '#8696a0', fontSize: 11 }}>{lastSeen}</span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ color: '#4a5568', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Login Via</span>
                              <span style={{ color: '#8696a0', fontSize: 11 }}>{loginMethodLabel}</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}

              {/* Storage & Data sub-page */}
              {settingsPage === 'storage' && (() => {
                const lsUsed = (() => { try { let b = 0; for (const k of Object.keys(localStorage)) b += (localStorage.getItem(k) || '').length * 2; return (b / 1024).toFixed(1) } catch { return '?' } })()
                const msgCount = (() => { try { let n = 0; for (const k of Object.keys(localStorage)) { if (k === 'live_messages') { const v = JSON.parse(localStorage.getItem(k) || '{}'); Object.values(v).forEach(a => { n += Array.isArray(a) ? a.length : 0 }) } } return n } catch { return 0 } })()
                return (
                  <div style={{ padding: '8px 0' }}>
                    {/* Storage card */}
                    <div style={{ margin: '8px 16px', padding: '18px', background: dm.panel, borderRadius: 14, border: `1px solid ${dm.border}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                        <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(139,92,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2"><path d="M22 12H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                        </div>
                        <div>
                          <div style={{ color: dm.text, fontSize: 15, fontWeight: 700 }}>Local Storage</div>
                          <div style={{ color: dm.subtext, fontSize: 12 }}>Used by SPVB on this device</div>
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        {[
                          { label: 'Storage Used', value: `${lsUsed} KB`, icon: '💾' },
                          { label: 'Cached Messages', value: `${msgCount}`, icon: '💬' },
                          { label: 'Saved Accounts', value: `${savedAccounts.length}`, icon: '👤' },
                          { label: 'Contacts Cached', value: `${spvbContacts.length}`, icon: '📋' },
                        ].map(({ label, value, icon }) => (
                          <div key={label} style={{ padding: '12px', background: dm.settingsBg, borderRadius: 10, textAlign: 'center' }}>
                            <div style={{ fontSize: 22, marginBottom: 4 }}>{icon}</div>
                            <div style={{ color: dm.text, fontSize: 16, fontWeight: 700 }}>{value}</div>
                            <div style={{ color: dm.subtext, fontSize: 11, marginTop: 2 }}>{label}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Auto-download media settings */}
                    <div style={{ margin: '8px 16px 0', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', padding: '8px 4px 6px' }}>Media Auto-Download</div>
                    <div style={{ background: dm.panel, borderRadius: 0 }}>
                      {[
                        { label: 'Photos', sub: 'Auto-download photos in chats', key: 'auto_dl_photos', def: true },
                        { label: 'Audio', sub: 'Auto-download voice & audio messages', key: 'auto_dl_audio', def: true },
                        { label: 'Videos', sub: 'Auto-download video messages', key: 'auto_dl_video', def: false },
                        { label: 'Documents', sub: 'Auto-download documents & files', key: 'auto_dl_docs', def: false },
                      ].map(({ label, sub, key, def }, idx, arr) => {
                        const val = localStorage.getItem(key) !== null ? localStorage.getItem(key) === 'on' : def
                        return (
                          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: idx < arr.length - 1 ? `1px solid ${dm.border}` : 'none' }}>
                            <div style={{ flex: 1 }}><div style={{ color: dm.text, fontSize: 14, fontWeight: 500 }}>{label}</div><div style={{ color: dm.subtext, fontSize: 12, marginTop: 1 }}>{sub}</div></div>
                            <div onClick={() => { localStorage.setItem(key, val ? 'off' : 'on'); window.dispatchEvent(new Event('storage')) }} style={{ width: 46, height: 26, background: val ? themeColor : '#2a3942', borderRadius: 13, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                              <div style={{ position: 'absolute', top: 3, left: val ? 22 : 3, width: 20, height: 20, background: 'white', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {/* Clear cache */}
                    <div style={{ margin: '16px 16px 0' }}>
                      <button onClick={() => {
                        if (!window.confirm('Clear local message cache? Your account and settings will be kept.')) return
                        const keep = ['token','user','dark_mode','chat_theme','app_font','notif_enabled','notif_sound','read_receipts','show_last_seen','show_online_status','spvb_accounts','saved_contacts','seen_status_users','seen_status_times']
                        const preserved = {}
                        keep.forEach(k => { const v = localStorage.getItem(k); if (v) preserved[k] = v })
                        localStorage.clear()
                        Object.entries(preserved).forEach(([k, v]) => localStorage.setItem(k, v))
                        alert('Cache cleared!')
                      }} style={{ width: '100%', padding: '13px', background: 'rgba(234,84,85,0.08)', border: '1.5px solid rgba(234,84,85,0.25)', borderRadius: 12, color: '#ea5455', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 14 }}>
                        Clear Message Cache
                      </button>
                      <div style={{ color: dm.subtext, fontSize: 11, textAlign: 'center', marginTop: 6 }}>Clears cached messages only · does not affect your account</div>
                    </div>
                  </div>
                )
              })()}

              {/* Encryption sub-page */}
              {settingsPage === 'privacy' && (
                <div style={{ marginTop: 0 }}>
                  <div style={{ margin: '16px 16px 6px', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>End-to-End Encryption</div>
                  <div style={{ background: dm.panel }}>
                    <div style={{ padding: '16px 20px', borderBottom: `1px solid ${dm.border}`, display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(37,211,102,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#25d366" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: dm.text, fontSize: 14, fontWeight: 600 }}>Messages are end-to-end encrypted</div>
                        <div style={{ color: dm.subtext, fontSize: 12, marginTop: 2 }}>
                          {v2PrivKeyRef.current ? '🔑 RSA master key loaded ✅' : '⚠️ RSA key not loaded — messages may show as encrypted'}
                        </div>
                      </div>
                    </div>
                    <div
                      onClick={() => setE2ePasswordNeeded(true)}
                      style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}
                    >
                      <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(99,102,241,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: dm.text, fontSize: 14, fontWeight: 600 }}>Restore Encryption Keys</div>
                        <div style={{ color: dm.subtext, fontSize: 12, marginTop: 2 }}>Enter password to restore keys on this device</div>
                      </div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={dm.subtext} strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                    </div>
                  </div>
                </div>
              )}

              {/* Help sub-page */}
              {settingsPage === 'help' && (
                <div style={{ padding: '8px 0' }}>
                  {/* FAQ */}
                  <div style={{ margin: '8px 16px 0', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', padding: '8px 4px 6px' }}>FAQ</div>
                  <div style={{ background: dm.panel }}>
                    {[
                      { q: 'How do messages work?', a: 'All messages are end-to-end encrypted and auto-delete after 24 hours by default.' },
                      { q: 'How to sync Google Contacts?', a: 'Tap the contacts icon in the top bar. You\'ll be asked for Google Contacts permission.' },
                      { q: 'How to connect Gmail?', a: 'Go to the ✉ Mail tab or Settings → Gmail → Connect.' },
                      { q: 'Is my data safe?', a: 'Yes. SPVB never stores your emails. Only your account info is stored on SPVB servers.' },
                      { q: 'How to change my name or about?', a: 'Go to Settings → Account and edit your Display Name or About text.' },
                      { q: 'How to enable notifications?', a: 'Go to Settings → Notifications and enable message notifications. Allow browser notifications when prompted.' },
                    ].map(({ q, a }, idx, arr) => (
                      <div key={q} style={{ padding: '14px 20px', borderBottom: idx < arr.length - 1 ? `1px solid ${dm.border}` : 'none' }}>
                        <div style={{ color: dm.text, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{q}</div>
                        <div style={{ color: dm.subtext, fontSize: 13, lineHeight: 1.55 }}>{a}</div>
                      </div>
                    ))}
                  </div>

                  {/* App info */}
                  <div style={{ margin: '16px 16px 0', color: dm.subtext, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', padding: '8px 4px 6px' }}>App Info</div>
                  <div style={{ background: dm.panel }}>
                    {[
                      { label: 'App Version', value: 'v1.3.0' },
                      { label: 'Build', value: 'Production' },
                      { label: 'Platform', value: typeof window !== 'undefined' && /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop Web' },
                    ].map(({ label, value }, idx, arr) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: idx < arr.length - 1 ? `1px solid ${dm.border}` : 'none' }}>
                        <span style={{ color: dm.text, fontSize: 14 }}>{label}</span>
                        <span style={{ color: dm.subtext, fontSize: 14 }}>{value}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ padding: '20px', textAlign: 'center' }}>
                    <div style={{ color: dm.subtext, fontSize: 12 }}>SPVB · Smart Private Video Bridge</div>
                    <div style={{ color: dm.subtext, fontSize: 11, marginTop: 4, opacity: 0.6 }}>© 2026 SPVB. All rights reserved.</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── QR DEVICE LINK APPROVAL NOTIFICATION ── */}
      {qrLinkRequest && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 900, width: 320, background: '#202c33', borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', border: '1px solid rgba(134,150,160,0.2)', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', background: '#2a3942', display: 'flex', alignItems: 'center', gap: 10 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            <span style={{ color: '#e9edef', fontSize: 14, fontWeight: 700 }}>New Device Login Request</span>
          </div>
          <div style={{ padding: '14px 16px' }}>
            <div style={{ color: '#e9edef', fontSize: 13, marginBottom: 4 }}>
              A device wants to link to your account:
            </div>
            <div style={{ color: themeColor, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
              {qrLinkRequest.device_name || 'Unknown Device'}
            </div>
            <div style={{ color: '#8696a0', fontSize: 11, marginBottom: 14 }}>
              Only approve if you scanned the QR code yourself.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => rejectQrLink(qrLinkRequest.token)} style={{ flex: 1, padding: '10px', background: 'rgba(234,84,85,0.12)', border: '1px solid rgba(234,84,85,0.3)', borderRadius: 10, color: '#ea5455', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>
                Deny
              </button>
              <button onClick={() => approveQrLink(qrLinkRequest.token)} style={{ flex: 1, padding: '10px', background: themeColor, border: 'none', borderRadius: 10, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>
                Approve
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── FULL-SCREEN STATUS VIEWER ── */}
      {viewingStatusGroups && (
        <StatusViewer
          statusGroups={viewingStatusGroups}
          startGroupIndex={viewingStatusStart}
          onClose={() => setViewingStatusGroups(null)}
          myUserId={user?.id}
          onDeleteStatus={deleteStatus}
          onSendStatusMessage={sendStatusMessageToChat}
        />
      )}

      {/* ── QUICK PROFILE MODAL ── */}
      {showQuickProfile && (
        <div className="wa-call-modal" onClick={() => setShowQuickProfile(false)}>
          <div className="wa-call-box" onClick={(e) => e.stopPropagation()} style={{ width: 'min(380px, 100vw)', gap: 0, padding: 0, overflow: 'hidden', maxHeight: '100dvh', overflowY: 'auto', borderRadius: window.innerWidth <= 768 ? 0 : undefined }}>

            {/* Cover photo area */}
            <div style={{ position: 'relative', height: 120, background: user.cover_url ? 'transparent' : `linear-gradient(135deg, ${themeColor}55, #1a2c35)`, flexShrink: 0 }}>
              {user.cover_url && <img src={user.cover_url} alt="cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              {coverUploading && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <div style={{ width: 26, height: 26, border: `3px solid rgba(255,255,255,0.3)`, borderTop: `3px solid white`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ color: 'white', fontSize: 11 }}>Uploading…</span>
                </div>
              )}
              {!coverUploading && (
                <label style={{ position: 'absolute', bottom: 8, right: 10, display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(0,0,0,0.55)', borderRadius: 16, padding: '5px 10px', cursor: 'pointer', color: 'white', fontSize: 12 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  Cover photo
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCover(f); e.target.value = '' }} />
                </label>
              )}

              {/* Avatar overlapping cover */}
              <label style={{ position: 'absolute', bottom: -28, left: 16, width: 60, height: 60, cursor: avatarUploading ? 'default' : 'pointer', display: 'block' }}>
                <div style={{ width: 60, height: 60, borderRadius: '50%', border: '3px solid #111b21', background: themeColor, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 22, overflow: 'hidden', position: 'relative' }}>
                  {user.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : userInitial}
                  {avatarUploading && (
                    <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%' }}>
                      <div style={{ width: 20, height: 20, border: `3px solid rgba(255,255,255,0.3)`, borderTop: `3px solid white`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    </div>
                  )}
                </div>
                {!avatarUploading && (
                  <div style={{ position: 'absolute', bottom: 0, right: -2, background: themeColor, borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #111b21' }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                  </div>
                )}
                <input type="file" accept="image/*" style={{ display: 'none' }} disabled={avatarUploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); e.target.value = '' }} />
              </label>
            </div>

            {/* Form body */}
            <div style={{ padding: '38px 20px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ color: '#8696a0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Edit Profile</div>

              <div>
                <label style={{ color: '#8696a0', fontSize: 11, display: 'block', marginBottom: 4 }}>Display Name</label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={50} placeholder="Your name"
                  style={{ width: '100%', padding: '10px 13px', background: '#2a3942', border: `1px solid ${themeColor}44`, borderRadius: 8, color: '#e9edef', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
              </div>

              <div>
                <label style={{ color: '#8696a0', fontSize: 11, display: 'block', marginBottom: 4 }}>About</label>
                <input value={editAbout} onChange={(e) => setEditAbout(e.target.value)} maxLength={140} placeholder="Hey there! I am using SPVB."
                  style={{ width: '100%', padding: '10px 13px', background: '#2a3942', border: '1px solid rgba(134,150,160,0.2)', borderRadius: 8, color: '#e9edef', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
                <div style={{ color: '#8696a0', fontSize: 10, textAlign: 'right', marginTop: 3 }}>{editAbout.length}/140</div>
              </div>

              <div style={{ padding: '10px 13px', background: '#1a2530', borderRadius: 8 }}>
                <div style={{ color: '#8696a0', fontSize: 11 }}>Phone Number</div>
                <div style={{ color: '#e9edef', fontSize: 14 }}>{user.phone || '—'}</div>
              </div>

              <div style={{ padding: '10px 13px', background: '#1a2530', borderRadius: 8 }}>
                <div style={{ color: '#8696a0', fontSize: 11 }}>Email</div>
                <div style={{ color: '#e9edef', fontSize: 14 }}>{user.email}</div>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setShowQuickProfile(false)}
                  style={{ flex: 1, padding: '11px', background: '#2a3942', border: 'none', borderRadius: 9, color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>Cancel</button>
                <button onClick={async () => { await saveProfile(); setShowQuickProfile(false) }} disabled={editSaving}
                  style={{ flex: 1, padding: '11px', background: themeColor, border: 'none', borderRadius: 9, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 600, opacity: editSaving ? 0.7 : 1 }}>
                  {editSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CHAT THEME MODAL ── */}
      {showChatThemeModal && activeId && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setShowChatThemeModal(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#111b21', borderRadius: 16, width: 340, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.7)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', background: '#202c33', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => setShowChatThemeModal(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>Chat Theme</div>
            </div>
            <div style={{ overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Color swatches */}
              <div>
                <div style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Chat Color</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                  {PER_CHAT_COLORS.map(c => {
                    const isSelected = (getChatTheme(activeId).color || 'default') === c.id
                    return (
                      <button key={c.id} onClick={() => saveChatTheme(activeId, { ...getChatTheme(activeId), color: c.id, bg: c.bg, bubble: c.bubble, recvBubble: c.recvBubble })}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '8px 4px', borderRadius: 10 }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'none'}>
                        <div style={{ width: 44, height: 44, borderRadius: '50%', background: c.bg || '#202c33', border: `3px solid ${isSelected ? themeColor : 'rgba(134,150,160,0.2)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                          {c.bubble && <div style={{ width: 22, height: 22, borderRadius: '50%', background: c.bubble }} />}
                          {isSelected && (
                            <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.35)' }}>
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                            </div>
                          )}
                        </div>
                        <span style={{ color: isSelected ? themeColor : '#8696a0', fontSize: 11 }}>{c.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* Received bubble color picker */}
              <div>
                <div style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>Received Bubble Color</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                  {[
                    { label: 'Default', color: null },
                    { label: 'Dark',    color: '#202c33' },
                    { label: 'Navy',    color: '#0a1a2e' },
                    { label: 'Teal',    color: '#0a2020' },
                    { label: 'Plum',    color: '#1a0a2e' },
                    { label: 'Wine',    color: '#2e0a0a' },
                    { label: 'Forest',  color: '#0a1a0e' },
                    { label: 'Slate',   color: '#141c22' },
                    { label: 'Coal',    color: '#181818' },
                    { label: 'Stone',   color: '#1e1a16' },
                  ].map(opt => {
                    const cur = getChatTheme(activeId).recvBubble || null
                    const isSel = cur === opt.color
                    return (
                      <button key={opt.label} onClick={() => saveChatTheme(activeId, { ...getChatTheme(activeId), recvBubble: opt.color })}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px', borderRadius: 8 }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'none'}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: opt.color || '#202c33', border: `2.5px solid ${isSel ? themeColor : 'rgba(134,150,160,0.2)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {isSel && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                        </div>
                        <span style={{ color: isSel ? themeColor : '#8696a0', fontSize: 10 }}>{opt.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* Font options */}
              <div>
                <div style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Chat Font</div>
                {PER_CHAT_FONTS.map(f => {
                  const isSelected = (getChatTheme(activeId).font || 'default') === f.id
                  return (
                    <div key={f.id} onClick={() => saveChatTheme(activeId, { ...getChatTheme(activeId), font: f.id })}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: isSelected ? '#2a3942' : 'transparent', borderRadius: 10, cursor: 'pointer', marginBottom: 4 }}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = '#1e2d35' }}
                      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}>
                      <span style={{ color: '#e9edef', fontSize: f.size || 14, fontFamily: f.font, flex: 1 }}>Aa — {f.name}</span>
                      {isSelected && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={themeColor} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                  )
                })}
              </div>
              {/* Reset */}
              <button onClick={() => { saveChatTheme(activeId, {}); setShowChatThemeModal(false) }}
                style={{ padding: '11px', background: 'rgba(234,84,85,0.1)', border: '1px solid rgba(234,84,85,0.2)', borderRadius: 10, color: '#ea5455', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600 }}>
                Reset to Default
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── CHAT LOCK / PIN MODAL ── */}
      {showLockModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.75)' }}
          onClick={() => setShowLockModal(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#111b21', borderRadius: 16, width: 320, boxShadow: '0 16px 48px rgba(0,0,0,0.7)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', background: '#202c33', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => setShowLockModal(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>
                {lockModalMode === 'set' ? 'Lock Chat' : lockModalMode === 'remove' ? 'Remove Lock' : 'Unlock Chat'}
              </div>
            </div>
            <div style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ textAlign: 'center', fontSize: 44 }}>{lockModalMode === 'unlock' ? '🔐' : lockModalMode === 'remove' ? '🔓' : '🔒'}</div>
              <div style={{ color: '#8696a0', fontSize: 13, textAlign: 'center', lineHeight: 1.6 }}>
                {lockModalMode === 'set'
                  ? 'Set a PIN to lock this chat. You will need it to open the chat.'
                  : lockModalMode === 'remove'
                    ? 'Enter your current PIN to remove the lock.'
                    : 'Enter your PIN to open this chat.'}
              </div>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={lockModalMode === 'set' ? 'New PIN (min 4 digits)' : 'Enter PIN'}
                value={lockPinInput}
                onChange={(e) => { setLockPinInput(e.target.value.replace(/\D/g, '')); setLockError('') }}
                onKeyDown={(e) => e.key === 'Enter' && confirmLockAction()}
                maxLength={8}
                autoFocus
                style={{ padding: '14px 16px', background: '#2a3942', border: `1.5px solid ${lockError ? '#ea5455' : `${themeColor}55`}`, borderRadius: 10, color: '#e9edef', fontSize: 22, fontFamily: 'monospace', outline: 'none', textAlign: 'center', letterSpacing: 8 }}
              />
              {lockError && <div style={{ color: '#ea5455', fontSize: 12, textAlign: 'center' }}>{lockError}</div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setShowLockModal(false)} style={{ flex: 1, padding: '12px', background: '#2a3942', border: 'none', borderRadius: 10, color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>Cancel</button>
                <button onClick={confirmLockAction} disabled={!lockPinInput}
                  style={{ flex: 1, padding: '12px', background: lockPinInput ? themeColor : '#2a3942', border: 'none', borderRadius: 10, color: lockPinInput ? 'white' : '#8696a0', cursor: lockPinInput ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: 14, fontWeight: 600 }}>
                  {lockModalMode === 'set' ? 'Set Lock' : lockModalMode === 'remove' ? 'Remove' : 'Unlock'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CREATE GROUP MODAL ── */}
      {showCreateGroup && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setShowCreateGroup(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#111b21', borderRadius: 16, width: 360, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.7)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', background: '#202c33', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid rgba(134,150,160,0.1)' }}>
              <button onClick={() => setShowCreateGroup(false)} style={{ background: 'none', border: 'none', color: '#8696a0', cursor: 'pointer', display: 'flex' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div style={{ color: '#e9edef', fontSize: 16, fontWeight: 600 }}>New Group</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <input
                placeholder="Group name…"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                maxLength={60}
                autoFocus
                style={{ padding: '12px 16px', background: '#2a3942', border: `1.5px solid ${themeColor}44`, borderRadius: 10, color: '#e9edef', fontSize: 15, fontFamily: 'inherit', outline: 'none' }}
              />
              <div style={{ color: '#8696a0', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Add Participants ({newGroupMembers.length} selected)
              </div>
              {allContacts.filter(c => c.isSpvb && !c.isInvite).length === 0 && (
                <div style={{ color: '#8696a0', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No contacts available</div>
              )}
              {allContacts.filter(c => c.isSpvb && !c.isInvite).map(c => {
                const sel = newGroupMembers.includes(c.id)
                return (
                  <div key={c.id} onClick={() => setNewGroupMembers(prev => sel ? prev.filter(x => x !== c.id) : [...prev, c.id])}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, cursor: 'pointer', background: sel ? `${themeColor}18` : 'transparent', border: `1px solid ${sel ? themeColor + '44' : 'transparent'}` }}
                    onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                    onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent' }}>
                    <div style={{ width: 42, height: 42, borderRadius: '50%', background: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 16, overflow: 'hidden', flexShrink: 0 }}>
                      {c.avatar_url ? <img src={c.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : c.initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#e9edef', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                    </div>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: sel ? themeColor : 'rgba(134,150,160,0.2)', border: `2px solid ${sel ? themeColor : 'rgba(134,150,160,0.3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {sel && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                  </div>
                )
              })}
            </div>
            <div style={{ padding: '12px 20px', background: '#202c33', borderTop: '1px solid rgba(134,150,160,0.1)', display: 'flex', gap: 10 }}>
              <button onClick={() => { setShowCreateGroup(false); setNewGroupName(''); setNewGroupMembers([]) }} style={{ flex: 1, padding: '12px', background: '#2a3942', border: 'none', borderRadius: 10, color: '#8696a0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>Cancel</button>
              <button onClick={createGroup} disabled={!newGroupName.trim() || newGroupMembers.length === 0}
                style={{ flex: 2, padding: '12px', background: newGroupName.trim() && newGroupMembers.length > 0 ? themeColor : '#2a3942', border: 'none', borderRadius: 10, color: newGroupName.trim() && newGroupMembers.length > 0 ? 'white' : '#8696a0', cursor: newGroupName.trim() && newGroupMembers.length > 0 ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: 14, fontWeight: 600 }}>
                Create Group
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── E2E Key Restore Modal — shown after QR/new device login or for Google users ── */}
      {/* Encryption Password Modal - Show ONLY once for QR/Google login */}
      {e2ePasswordNeeded && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#1e293b', borderRadius: 16, padding: 32, width: '100%', maxWidth: 380, boxShadow: '0 24px 60px rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>
                {passwordValidated ? '✅' : '🔐'}
              </div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>
                {passwordValidated ? 'Password Verified!' : 'Verify Password'}
              </h2>
              <p style={{ margin: '8px 0 0', fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>
                {passwordValidated ? 'Decrypting your messages...' : 'Enter your password to unlock messages on this device.'}
              </p>
            </div>

            {!passwordValidated && (
              <>
                <input
                  type="password"
                  placeholder="Your account password"
                  value={e2ePasswordInput}
                  onChange={e => setE2ePasswordInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e2ePasswordLoading && restoreE2eKeyWithPassword(e2ePasswordInput)}
                  autoFocus
                  style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: `1px solid ${e2ePasswordError ? '#ef4444' : 'rgba(255,255,255,0.1)'}`, background: 'rgba(255,255,255,0.05)', color: '#f1f5f9', fontSize: 15, outline: 'none', boxSizing: 'border-box', marginBottom: 8 }}
                />
                {e2ePasswordError && (
                  <p style={{ margin: '0 0 12px', fontSize: 12, color: '#ef4444' }}>{e2ePasswordError}</p>
                )}
                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                  <button
                    onClick={() => restoreE2eKeyWithPassword(e2ePasswordInput)}
                    disabled={!e2ePasswordInput || e2ePasswordLoading}
                    style={{ flex: 1, padding: '11px', borderRadius: 10, border: 'none', background: e2ePasswordInput && !e2ePasswordLoading ? '#25d366' : '#334155', color: 'white', cursor: e2ePasswordInput && !e2ePasswordLoading ? 'pointer' : 'default', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', transition: 'background 0.2s' }}
                  >
                    {e2ePasswordLoading ? 'Verifying…' : 'Verify'}
                  </button>
                </div>
              </>
            )}

            {passwordValidated && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 8 }}>
                <span style={{ fontSize: 12, color: '#25d366' }}>●</span>
                <span style={{ fontSize: 12, color: '#25d366' }}>●</span>
                <span style={{ fontSize: 12, color: '#25d366' }}>●</span>
              </div>
            )}

            <p style={{ margin: '14px 0 0', fontSize: 11, color: '#475569', textAlign: 'center' }}>
              {passwordValidated ? 'Unlocking messages...' : 'Password verified once per session.'}
            </p>
          </div>
        </div>
      )}

      {/* Full Screen Loading - While decrypting messages */}
      {decryptingMessages && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 24 }}>
          <div style={{ fontSize: 60 }}>🔓</div>
          <div style={{ fontSize: 18, color: '#f1f5f9', fontWeight: 600 }}>Decrypting Messages</div>
          <div style={{ fontSize: 24, color: '#25d366' }}>⟳</div>
          <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading your messages...</div>
        </div>
      )}
    </div>
  )
}
