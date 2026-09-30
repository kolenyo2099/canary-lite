// Canary service worker: opens the app, and keeps collection running on a one-minute alarm.
// The collectors themselves run in an offscreen document (see src/offscreen.js).
const ensureAlarm = () => chrome.alarms.create('collect', { periodInMinutes: 1 })
chrome.runtime.onInstalled.addListener(ensureAlarm)
chrome.runtime.onStartup.addListener(ensureAlarm)

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }))

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Downloads and parses GDELT files and news feeds in the background' })
  } catch (error) {
    // Two wake-ups can race to create it; only one document may exist.
    if (!String(error?.message).includes('single offscreen')) throw error
  }
}

// Runtime messages are delivered to every extension context.  Keep the relay
// messages out of this listener: otherwise a service worker that happens to
// receive its own relay can start forwarding the same request again instead of
// letting the offscreen document handle it.
async function sendToCollector(type, projectId) {
  await ensureOffscreen()
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type, projectId })
  if (result === undefined) throw new Error('The background collector did not respond')
  return result
}

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== 'collect') return
  try {
    await sendToCollector('tick')
  } catch (error) {
    // Alarms must continue even if Chrome discarded an offscreen document.
    // The next alarm recreates it; keep the diagnostic in the service-worker log.
    console.error('Canary collector alarm failed:', error)
  }
})

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.target === 'offscreen') return
  if (message.type === 'prepare-nlp') {
    // Keep long model downloads between the app and offscreen document, so
    // they do not depend on the service worker's maximum event lifetime.
    ensureOffscreen().then(() => reply({ ready: true }), error => reply({ error: error.message || String(error) }))
    return true
  }
  if (message.type !== 'run-now') return
  sendToCollector('run-now', message.projectId)
    .then(reply, () => reply(false))
  return true
})
