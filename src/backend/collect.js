// Port of desktop scheduler.rs. Each lane (events, gkg, rss, mediacloud) runs under a Web Lock, so the
// offscreen collector and an open app tab never process the same lane twice at once.
import { getProject, listProjects, patchProject, itemUpserter, createLog, finishLog, now } from './store.js'
import { getSetting, setSetting, get, putMany } from './db.js'
import { compileQueries, rssWindows, rssUrl, simpleFilterPasses } from './rss.js'
import { fetchForProject, configuredToken } from './mediacloud.js'
import { decodeEntities } from './gdelt.js'
import { enrichItems } from './nlp.js'

const GDELT = 'https://data.gdeltproject.org/gdeltv2'
const FILES_PER_RUN = 8
const MIN_FRESHNESS_MINUTES = 30
const RSS_SEARCHES_PER_RUN = 120
const RSS_PAUSE_MS = 60 * 60_000
const QUARTER = 900_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('canary')

// ── Parse worker ─────────────────────────────────────────────────────────────
let worker, nextId = 0
const pending = new Map()
function parse(message, buffer) {
  if (!worker) {
    worker = new Worker(new URL('./parseWorker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id)
      pending.delete(data.id)
      data.error ? task?.reject(new Error(data.error)) : task?.resolve(data.items)
    }
    worker.onerror = event => {
      for (const task of pending.values()) task.reject(new Error(event.message || 'Parser worker failed'))
      pending.clear(); worker.terminate(); worker = null
    }
  }
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ ...message, id, buffer }, [buffer])
  })
}

async function download(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal })
  if (response.status === 404) return null // not published yet; retry on the next run
  if (!response.ok) {
    const error = new Error(`${new URL(url).hostname}: HTTP ${response.status}`)
    error.status = response.status
    error.retryAfter = Number(response.headers.get('retry-after')) || 0
    throw error
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > 50_000_000) throw new Error(`${url} exceeds the 50 MB limit`)
  return buffer
}

// ── GDELT file cursors ───────────────────────────────────────────────────────
const stamp = ms => new Date(ms).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const quarterStart = ms => Math.floor(ms / QUARTER) * QUARTER
export function urlTime(url) {
  const s = String(url || '').match(/\/(\d{14})\./)?.[1]
  return s ? Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`) : null
}
// The next FILES_PER_RUN quarter-hour files after the cursor (or from the project start). One file past the
// local clock is included because clocks drift; an unpublished file answers 404 and ends the run.
export function nextFiles(cursorMs, sinceMs, suffix, nowMs = Date.now()) {
  const first = cursorMs != null ? cursorMs + QUARTER : quarterStart(sinceMs)
  const urls = []
  for (let ms = first; ms <= nowMs + QUARTER && urls.length < FILES_PER_RUN; ms += QUARTER) urls.push(`${GDELT}/${stamp(ms)}.${suffix}`)
  return urls
}

// GDELT stamps all rows in a quarter-hour export with the file's quarter-hour
// timestamp. A project created at 12:15:12 must include rows stamped 12:15:00.
// Older extension builds skipped that first file but advanced the cursor, so
// replay it once after upgrading if it is still the current cursor.
export function gdeltFilePlan(project, kind, stream, cursorMs, suffix, nowMs = Date.now()) {
  const sinceMs = Date.parse(project.collecting_since || project.created_at)
  const firstMs = quarterStart(sinceMs)
  const replayField = `initial_window_checked_${kind}_${stream}`
  const replay = !project[replayField] && cursorMs === firstMs && sinceMs > firstMs
  const urls = nextFiles(cursorMs, sinceMs, suffix, nowMs)
  if (replay) urls.unshift(`${GDELT}/${stamp(firstMs)}.${suffix}`)
  return { urls: urls.slice(0, FILES_PER_RUN), start: new Date(firstMs).toISOString(), replayField, firstMs }
}

const STREAMS = {
  events: [
    { stream: 'english', suffix: 'export.CSV.zip', cursor: p => urlTime(p.last_events_url), save: url => ({ last_events_url: url }) },
    { stream: 'translation', suffix: 'translation.export.CSV.zip', cursor: p => urlTime(p.last_events_translation_url), save: url => ({ last_events_translation_url: url }) },
  ],
  gkg: [
    { stream: 'english', suffix: 'gkg.csv.zip', cursor: p => p.last_doc_collected_at && Date.parse(p.last_doc_collected_at), save: url => ({ last_doc_collected_at: new Date(urlTime(url)).toISOString() }) },
    { stream: 'translation', suffix: 'translation.gkg.csv.zip', cursor: p => p.last_doc_translation_collected_at && Date.parse(p.last_doc_translation_collected_at), save: url => ({ last_doc_translation_collected_at: new Date(urlTime(url)).toISOString() }) },
  ],
}

async function collectGdelt(kind, project, log, signal) {
  const upsert = await itemUpserter(project.project_id)
  const errors = [], fresh = []
  for (const { stream, suffix, cursor, save } of STREAMS[kind]) {
    const plan = gdeltFilePlan(project, kind, stream, cursor(project) || null, suffix)
    for (const url of plan.urls) {
      if (signal.aborted) throw new DOMException('Collection stopped', 'AbortError')
      let buffer
      try { buffer = await download(url, signal) } catch (error) {
        if (error.name === 'AbortError') throw error
        errors.push(error.message); break
      }
      if (!buffer) break
      log.checked_count++
      // GDELT stamps rows with their export's quarter-hour time, so use the
      // floored project start while still excluding older exports.
      const items = await parse({ kind, project, start: plan.start, end: new Date(Date.now() + 86_400_000).toISOString(), stream }, buffer)
      fresh.push(...await upsert(items, !!project.sheet_sink))
      log.fetch_count += items.length
      log.new_count = fresh.length
      await patchProject(project.project_id, { ...save(url), ...(urlTime(url) === plan.firstMs ? { [plan.replayField]: true } : {}) })
      await saveLogProgress(log)
    }
  }
  await patchProject(project.project_id, kind === 'events' ? { last_events_collected_at: now() } : { last_doc_polled_at: now() })
  if (kind === 'events' && fresh.length) enrichTitles(fresh)
  return errors.length ? errors.join('; ') : null
}

// Logs are rewritten while a lane runs so the Activity view shows progress.
const saveLogProgress = log => putMany('logs', [log])

// ── Event title enrichment (optional all-sites permission) ───────────────────
const OG = [/<meta\b[^>]*property=["']og:title["'][^>]*content=["'](.*?)["']/i, /<meta\b[^>]*content=["'](.*?)["'][^>]*property=["']og:title["']/i]
export function pageTitle(html) {
  for (const re of OG) { const t = decodeEntities(html.match(re)?.[1] || '').trim(); if (t) return t.slice(0, 300) }
  const t = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 300) : null
}
async function fetchTitle(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' }, credentials: 'omit' })
    if (response.status !== 200 || !response.body) return null
    const reader = response.body.getReader(), chunks = []
    let size = 0
    while (size < 32_768) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length }
    reader.cancel().catch(() => {})
    return pageTitle(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()).slice(0, 32_768))
  } catch { return null }
}
async function enrichTitles(items) {
  if (!await getSetting('title_enrichment')) return
  const byUrl = new Map()
  for (const item of items) if (item.url && /( @ |^\[|^GDELT Event$)/.test(item.title_or_summary)) byUrl.set(item.url, [...(byUrl.get(item.url) || []), item.item_id])
  for (const [url, ids] of [...byUrl].slice(0, 20)) {
    const title = await fetchTitle(url)
    if (!title) continue
    const current = (await Promise.all(ids.map(id => get('items', id)))).filter(Boolean)
    await putMany('items', current.map(item => ({ ...item, title_or_summary: title })))
  }
}

// ── Google News RSS ──────────────────────────────────────────────────────────
// Google News blocks bursts: space searches out, cap each run, and stop without retrying once it pushes back.
const rssGap = () => sleep(2500 + Math.random() * 1500)
async function collectRss(project, log, signal) {
  const pausedUntil = await getSetting('rss_paused_until')
  if (pausedUntil && pausedUntil > now()) return `Google News paused until ${new Date(pausedUntil).toLocaleTimeString()} after it limited requests.`
  const upsert = await itemUpserter(project.project_id)
  const since = project.collecting_since || project.created_at
  const end = now()
  const cursors = { ...project.rss_cursors }
  const rules = project.watchlists.filter(r => r.lane === 'rss' && r.enabled)
    .sort((a, b) => (cursors[a.bucket_name] || since).localeCompare(cursors[b.bucket_name] || since)) // least recently collected first
  let searched = 0, note = null
  plan: for (const rule of rules) {
    const queries = compileQueries(project, rule)
    const start = cursors[rule.bucket_name] || since
    for (const window of rssWindows(start, end)) {
      if (searched + queries.length > RSS_SEARCHES_PER_RUN) { note = `Limited to ${searched} Google News searches to avoid being blocked; the rest continue next run.`; break plan }
      for (const query of queries) {
        if (signal.aborted) throw new DOMException('Collection stopped', 'AbortError')
        if (searched++) await rssGap()
        let buffer
        try { buffer = await download(rssUrl(query.query, query.locale, window.start, window.end), signal) } catch (error) {
          if (error.status !== 429 && error.status !== 503) throw error
          const until = new Date(Date.now() + (error.retryAfter ? error.retryAfter * 1000 : RSS_PAUSE_MS)).toISOString()
          await setSetting('rss_paused_until', until)
          note = `Google News is limiting requests. RSS is paused until ${new Date(until).toLocaleTimeString()}.`
          break plan
        }
        if (!buffer) continue
        log.checked_count++
        const candidates = await parse({ kind: 'rss', project, rule, query, start: window.start, end: window.end, deferSimpleFilter: true }, buffer)
        await enrichItems(candidates, signal)
        const items = candidates.filter(item => simpleFilterPasses(rule.logic, item.title_or_summary,
          [item.snippet_or_context, item.normalized?.description_text].filter(Boolean).join(' '), item.normalized))
        log.fetch_count += items.length
        log.new_count += (await upsert(items, !!project.sheet_sink)).length
        await saveLogProgress(log)
      }
      cursors[rule.bucket_name] = window.end
      await patchProject(project.project_id, { rss_cursors: cursors })
    }
  }
  await patchProject(project.project_id, { last_rss_collected_at: now() })
  return note
}

export async function collectMediaCloud(project, log, signal) {
  const token = await configuredToken()
  if (!token) return 'Configure a Media Cloud API token first'
  const [items, error] = await fetchForProject(project, token, signal)
  signal?.throwIfAborted()
  await enrichItems(items, signal)
  const rules = new Map(project.watchlists.filter(r => r.lane === 'mediacloud' && r.enabled).map(r => [r.bucket_name, r]))
  const accepted = items.filter(item => simpleFilterPasses(rules.get(item.query_bucket)?.logic, item.title_or_summary, '', item.normalized))
  const upsert = await itemUpserter(project.project_id)
  log.checked_count = 1
  log.fetch_count = items.length
  log.new_count = (await upsert(accepted, !!project.sheet_sink)).length
  // Preserve the search window on partial failures so the next run retries it.
  signal?.throwIfAborted()
  if (!error) await patchProject(project.project_id, { last_mediacloud_collected_at: now() })
  return error
}

// ── Runs ─────────────────────────────────────────────────────────────────────
const LANES = { events: p => collectGdelt('events', ...p), gkg: p => collectGdelt('gkg', ...p), rss: p => collectRss(...p), mediacloud: p => collectMediaCloud(...p) }
const running = new Map() // log_id → AbortController, for runs in this context

channel?.addEventListener('message', ({ data }) => { if (data?.type === 'cancel') running.get(data.logId)?.abort() })

// Runs one lane unless it is already running anywhere. Resolves when it finishes.
function runLane(projectId, lane) {
  const work = async () => {
    const project = await getProject(projectId)
    if (!project) return
    const log = await createLog(projectId, lane)
    const controller = new AbortController()
    running.set(log.log_id, controller)
    channel?.postMessage({ type: 'changed', projectId })
    try {
      const error = await LANES[lane]([project, log, controller.signal])
      await finishLog(log, { error })
    } catch (error) {
      await finishLog(log, { error: error.name === 'AbortError' ? 'Cancelled by user' : error.message || String(error) })
    } finally {
      running.delete(log.log_id)
      channel?.postMessage({ type: 'changed', projectId })
    }
  }
  return navigator.locks
    ? navigator.locks.request(`canary:${projectId}:${lane}`, { ifAvailable: true }, lock => lock && work())
    : work()
}

const enabledLanes = p => [['events', p.events_enabled], ['gkg', p.doc_enabled], ['rss', p.rss_enabled], ['mediacloud', p.mediacloud_enabled]]
  .filter(([, on]) => on).map(([lane]) => lane)

// "Run now": every enabled lane. Returns false when the project is paused or has no enabled lane.
export async function runProjectNow(projectId) {
  const project = await getProject(projectId)
  if (!project || project.polling_config.paused) return false
  const lanes = enabledLanes(project.polling_config)
  for (const lane of lanes) runLane(projectId, lane)
  return lanes.length > 0
}

// Scheduler tick: start lanes whose interval elapsed or whose GDELT cursor is behind.
export async function collectDue(nowMs = Date.now()) {
  for (const project of await listProjects()) {
    const pc = project.polling_config
    if (pc.paused) continue
    const since = Date.parse(project.collecting_since || project.created_at)
    const elapsed = (last, minutes) => !last || nowMs - Date.parse(last) >= minutes * 60_000
    const behind = (lane, minutes) => STREAMS[lane].some(s => nowMs - (s.cursor(project) || since) > Math.max(minutes, MIN_FRESHNESS_MINUTES) * 60_000)
    const due = {
      events: pc.events_enabled && (behind('events', pc.events_interval_minutes) || elapsed(project.last_events_collected_at, pc.events_interval_minutes)),
      gkg: pc.doc_enabled && (behind('gkg', pc.doc_interval_minutes) || elapsed(project.last_doc_polled_at, pc.doc_interval_minutes)),
      rss: pc.rss_enabled && elapsed(project.last_rss_collected_at, pc.rss_interval_minutes),
      mediacloud: pc.mediacloud_enabled && elapsed(project.last_mediacloud_collected_at, pc.mediacloud_interval_minutes),
    }
    for (const [lane, go] of Object.entries(due)) if (go) runLane(project.project_id, lane)
  }
}
