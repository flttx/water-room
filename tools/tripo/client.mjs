// Minimal Tripo v3 API client (node >= 22, global fetch). The API key is never printed or persisted.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BASE_URL = 'https://openapi.tripo3d.ai/v3'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let cachedKey = ''
function loadKey() {
  if (cachedKey) return cachedKey
  let key = (process.env.TRIPO_API_KEY ?? '').trim()
  if (!key && process.platform === 'win32') {
    try {
      key = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('TRIPO_API_KEY','User')"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { key = '' }
  }
  const envFile = path.join(ROOT, '.env')
  if (!key && existsSync(envFile)) {
    const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => /^\s*TRIPO_API_KEY\s*=/.test(l))
    key = line ? line.replace(/^\s*TRIPO_API_KEY\s*=\s*/, '').replace(/^['"]|['"]$/g, '').trim() : ''
  }
  if (!key) throw new Error('TRIPO_API_KEY not found (env, Windows user env, or .env)')
  cachedKey = key
  return key
}

/** Strip the key from any text before it can reach a log or an error message. */
export function redact(text) {
  const s = String(text ?? '')
  return cachedKey ? s.split(cachedKey).join('<redacted>') : s
}

export class TripoError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(redact(message))
    this.status = status
    this.code = code
    this.body = body
  }
}

/**
 * JSON request against the v3 API. Retries 429 (codes 1007 rate / 2000 concurrency), 5xx and network
 * errors with exponential backoff (1 s → 32 s cap, Retry-After / X-RateLimit-Reset honoured).
 * Returns `data` from the `{ code, data }` envelope.
 */
export async function request(method, endpoint, body, { retries = 8 } = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_URL}${endpoint}`
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${loadKey()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err) {
      if (attempt >= retries) throw new TripoError(`${method} ${endpoint}: network error ${err?.message ?? err}`)
      await sleep(Math.min(32, 2 ** attempt) * 1000)
      continue
    }
    const text = await res.text()
    let json
    try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text.slice(0, 300) } }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      const wait = retryAfter > 0 ? retryAfter : reset > 0 ? Math.max(reset - Math.floor(Date.now() / 1000), 1) : Math.min(32, 2 ** attempt)
      await sleep(Math.min(wait, 60) * 1000)
      continue
    }
    if (!res.ok || (json.code !== undefined && json.code !== 0)) {
      throw new TripoError(`${method} ${endpoint}: HTTP ${res.status} code=${json.code} ${json.message ?? ''} ${json.suggestion ?? ''}`.trim(), { status: res.status, code: json.code, body: json })
    }
    return json.data ?? json
  }
}

/** POST /generation/<endpoint> → task_id */
export async function createTask(endpoint, body) {
  const data = await request('POST', endpoint.startsWith('/') ? endpoint : `/generation/${endpoint}`, body)
  if (!data?.task_id) throw new TripoError(`${endpoint}: no task_id in response`, { body: data })
  return data.task_id
}

export async function getTask(taskId) {
  return request('GET', `/tasks/${taskId}`)
}

const TERMINAL_FAIL = new Set(['failed', 'cancelled', 'canceled', 'banned', 'expired', 'unknown'])

/** Poll a task every `interval` ms until success; throws on terminal failure or timeout. */
export async function waitTask(taskId, { timeoutMs = 20 * 60_000, interval = 3000, onProgress } = {}) {
  const started = Date.now()
  let lastStatus = ''
  for (;;) {
    let task
    try {
      task = await getTask(taskId)
    } catch (err) {
      if (err.status && err.status < 500 && err.status !== 429) throw err
      task = null
    }
    if (task) {
      if (task.status === 'success') return task
      if (TERMINAL_FAIL.has(task.status)) {
        throw new TripoError(`task ${taskId} ${task.status}${task.error_msg ? `: ${task.error_msg}` : ''}${task.message ? `: ${task.message}` : ''}`, { body: task })
      }
      if (onProgress && task.status !== lastStatus) onProgress(task)
      lastStatus = task.status
    }
    if (Date.now() - started > timeoutMs) throw new TripoError(`task ${taskId} timed out after ${Math.round(timeoutMs / 1000)} s (last status ${lastStatus || 'n/a'})`)
    await sleep(interval)
  }
}

const EXT_BY_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'model/gltf-binary': '.glb' }

/**
 * Download a (pre-signed CDN) URL without auth headers. If `dest` has no extension, one is derived
 * from the content-type / URL. Returns { path, bytes }.
 */
export async function download(url, dest, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      let target = dest
      if (!path.extname(dest)) {
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
        const urlExt = path.extname(new URL(url).pathname).toLowerCase()
        target = dest + (EXT_BY_TYPE[type] ?? (urlExt || '.bin'))
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, buf)
      return { path: target, bytes: buf.byteLength }
    } catch (err) {
      if (attempt >= retries) throw new TripoError(`download failed (${path.basename(dest)}): ${err?.message ?? err}`)
      await sleep(2 ** attempt * 1000)
    }
  }
}

/** GET /account/balance → { balance, frozen } */
export async function balance() {
  return request('GET', '/account/balance')
}

/** Pick the first URL in task.output whose key matches one of `keys` (in order), else any URL. */
export function outputUrl(task, keys) {
  const out = task?.output ?? {}
  for (const k of keys) if (typeof out[k] === 'string' && out[k].startsWith('http')) return out[k]
  return undefined
}
