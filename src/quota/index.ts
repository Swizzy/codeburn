// Provider capacity readers for `codeburn quota`.
//
// These adapters were ported from the Electron desktop app's copies under
// `app/electron/quota/*.ts`, which remain the origin and are still what the
// desktop app runs. They are deliberately left untouched by this change; the
// two trees will be deduped in a follow-up once every surface reads the CLI.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { claudeConfigSourceId, getClaudeConfigDirs } from '../providers/claude.js'
import { renderTable } from '../text-table.js'
import { fetchAntigravityQuota } from './antigravity.js'
import { claudeProfileLabel, fetchClaudeQuota, uniqueProfileLabels } from './claude.js'
import { fetchClinePassQuota } from './clinepass.js'
import { fetchCodexQuota } from './codex.js'
import { fetchCopilotQuota } from './copilot.js'
import { fetchCursorQuota } from './cursor.js'
import { fetchGeminiQuota } from './gemini.js'
import { fetchGrokQuota } from './grok.js'
import { fetchGrokbotQuota, grokbotInstalled } from './grokbot.js'
import { fetchKimiQuota } from './kimi.js'
import { KEYCHAIN_TIMEOUT_MS } from './security.js'
import type { ProviderName, QuotaProvider } from './types.js'
import { fetchZaiQuota } from './zai.js'
import { fetchZcodeQuota } from './zcode.js'

export type QuotaCommandWindow = { label: string; usedPct: number; resetsAt?: string }

export type QuotaCommandProvider = {
  id: ProviderName
  name: string
  available: boolean
  plan?: string
  windows: QuotaCommandWindow[]
  error?: string
  /** Provider facts that are not a window, such as Codex's limit-reset credits.
   *  Printed under the provider's rows and carried in `--format json`. */
  notes?: string[]
}

/** One Claude config directory's quota, for the Capacity Dock's per-profile rings.
 *  Present only when two or more directories are configured; `providers[]` keeps
 *  its single `claude` entry for `~/.claude` regardless. */
export type QuotaClaudeProfile = Omit<QuotaCommandProvider, 'id'> & { id: string; label: string; path: string }

export type QuotaReport = { providers: QuotaCommandProvider[]; claudeProfiles?: QuotaClaudeProfile[] }

export type ProviderReader = (signal: AbortSignal) => Promise<QuotaProvider>

const READERS: { id: ProviderName; name: string; read: ProviderReader }[] = [
  { id: 'claude', name: 'Claude', read: async signal => (await fetchClaudeQuota({ signal, allowKeychain: true })).quota },
  // No keychain for Codex: it would prefer the menubar's read-only cached token
  // over `~/.codex/auth.json`, which this process may refresh and write back.
  { id: 'codex', name: 'Codex', read: async signal => (await fetchCodexQuota({ signal })).quota },
  { id: 'gemini', name: 'Gemini', read: async signal => (await fetchGeminiQuota({ signal })).quota },
  { id: 'copilot', name: 'GitHub Copilot', read: async signal => (await fetchCopilotQuota({ signal })).quota },
  { id: 'antigravity', name: 'Antigravity', read: () => fetchAntigravityQuota() },
  { id: 'kimi', name: 'Kimi', read: async signal => (await fetchKimiQuota({ signal })).quota },
  { id: 'cursor', name: 'Cursor', read: async signal => (await fetchCursorQuota({ signal })).quota },
  { id: 'zai', name: 'Z.ai', read: async signal => (await fetchZaiQuota({ signal })).quota },
  { id: 'zcode', name: 'ZCode', read: async signal => (await fetchZcodeQuota({ signal })).quota },
  { id: 'grok', name: 'Grok', read: async signal => (await fetchGrokQuota({ signal })).quota },
  { id: 'grokbot', name: 'Grok Bot', read: async signal => (await fetchGrokbotQuota({ signal })).quota },
  { id: 'clinepass', name: 'ClinePass', read: async signal => (await fetchClinePassQuota({ signal })).quota },
]

/** Grok Bot is an optional desktop app rather than a signed-in account. With
 *  the app absent its reader would still answer — with the Cursor allowance of
 *  whoever is signed into Cursor, under a Grok Bot label — so the row is left
 *  out entirely. */
export function availableReaders(installed: () => boolean = grokbotInstalled): typeof READERS {
  return READERS.filter(entry => entry.id !== 'grokbot' || installed())
}

// Must cover the slowest documented per-reader allowance - Claude's keychain
// fallback waits up to KEYCHAIN_TIMEOUT_MS for the macOS "Allow" dialog - or
// this outer race aborts a reader that is still legitimately waiting and
// misreports it as disconnected. Derived rather than a separate literal so
// the two cannot drift apart; the margin covers the request itself.
const DEFAULT_TIMEOUT_MS = KEYCHAIN_TIMEOUT_MS + 5_000

function errorFor(quota: QuotaProvider): string | undefined {
  switch (quota.connection) {
    case 'accessDenied':
      return quota.footerLines[0] ?? 'Access to the stored credential was denied.'
    case 'terminalFailure':
      return quota.footerLines[0] ?? 'The provider rejected the request.'
    case 'transientFailure':
      return quota.footerLines[0] ?? 'Temporarily unavailable.'
    default:
      return undefined
  }
}

function toWindows(quota: QuotaProvider): QuotaCommandWindow[] {
  const rows = quota.details.length > 0 ? quota.details : quota.primary ? [quota.primary] : []
  return rows.map(row => ({
    label: row.label,
    usedPct: Math.round(row.percent * 1000) / 10,
    ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}),
  }))
}

export function toCommandProvider(id: ProviderName, name: string, quota: QuotaProvider): QuotaCommandProvider {
  const error = errorFor(quota)
  // errorFor() only surfaces footerLines on a non-connected state; a connected
  // read (e.g. Grok Bot's "this is the Cursor account's allowance" disclosure)
  // still needs its first line said out loud so it isn't shown as fact-free.
  const baseNotes = quota.notes ?? []
  const footerNote =
    quota.connection === 'connected' && quota.footerLines.length > 0 ? quota.footerLines[0] : undefined
  const notes = [
    ...baseNotes,
    ...(footerNote && !baseNotes.includes(footerNote) ? [footerNote] : []),
  ]
  return {
    id,
    name,
    available: quota.connection === 'connected',
    ...(quota.planLabel ? { plan: quota.planLabel } : {}),
    windows: toWindows(quota),
    ...(error ? { error } : {}),
    ...(notes.length ? { notes } : {}),
  }
}

const TIMED_OUT: QuotaCommandProvider = { id: 'claude', name: 'Claude', available: false, windows: [], error: 'Timed out.' }

async function readWithTimeout(
  read: (signal: AbortSignal) => Promise<QuotaProvider>,
  timeoutMs: number,
): Promise<QuotaProvider | 'timeout'> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const timedOut = new Promise<'timeout'>(resolve => { controller.signal.addEventListener('abort', () => resolve('timeout')) })
  try {
    return await Promise.race([read(controller.signal), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/** One config directory's Claude quota: the same endpoint the `claude` row reads, against
 *  that directory's own credential file rather than the default one. */
export function readClaudeProfileFrom(dir: string, signal: AbortSignal): Promise<QuotaProvider> {
  return fetchClaudeQuota({ signal, credentialPath: join(dir, '.credentials.json') }).then(result => result.quota)
}

/** A directory's answer as a provider row, under the same timeout every reader gets. */
async function readProfileBase(
  dir: string,
  read: (dir: string, signal: AbortSignal) => Promise<QuotaProvider>,
  timeoutMs: number,
): Promise<QuotaCommandProvider> {
  const quota = await readWithTimeout(signal => read(dir, signal), timeoutMs)
  if (quota === 'timeout') {
    return TIMED_OUT
  }
  return toCommandProvider('claude', 'Claude', quota)
}

/** Stands in for the default directory's answer until the provider reads have settled:
 *  `~/.claude` is what the `claude` row already asked for, and asking again would spend a
 *  second request on the same credential. */
const REUSE_CLAUDE_ROW = Symbol('reuse the claude row')
type PendingProfile = { dir: string; label: string; base: QuotaCommandProvider | typeof REUSE_CLAUDE_ROW }

export async function collectQuota(options: {
  readers?: { id: ProviderName; name: string; read: ProviderReader }[]
  timeoutMs?: number
  claudeConfigDirs?: string[]
  readClaudeProfile?: (dir: string, signal: AbortSignal) => Promise<QuotaProvider>
} = {}): Promise<QuotaReport> {
  const readers = options.readers ?? availableReaders()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Providers and profiles read as one wave: the profile reads start before the provider
  // ones are awaited, so a stalled reader on each side costs one timeout, not two in a row.
  const dirsPromise = options.claudeConfigDirs ? Promise.resolve(options.claudeConfigDirs) : getClaudeConfigDirs()
  const providersPromise = Promise.all(readers.map(async entry => {
    const quota = await readWithTimeout(entry.read, timeoutMs)
    if (quota === 'timeout') {
      return { id: entry.id, name: entry.name, available: false, windows: [], error: 'Timed out.' }
    }
    return toCommandProvider(entry.id, entry.name, quota)
  }))
  // An injected reader belongs to a caller that wants every directory read, so the default
  // directory is only reused when this module's own reader is the one doing the reading.
  const readProfile = options.readClaudeProfile ?? readClaudeProfileFrom
  const defaultDir = options.readClaudeProfile ? null : resolve(homedir(), '.claude')
  const profilesPromise = dirsPromise.then(async (dirs): Promise<PendingProfile[] | undefined> => {
    if (dirs.length < 2) {
      return undefined
    }
    const labels = uniqueProfileLabels(dirs.map(dir => claudeProfileLabel(dir)))
    return await Promise.all(dirs.map(async (dir, index): Promise<PendingProfile> => {
      if (defaultDir !== null && resolve(dir) === defaultDir) {
        return { dir, label: labels[index], base: REUSE_CLAUDE_ROW }
      }
      return { dir, label: labels[index], base: await readProfileBase(dir, readProfile, timeoutMs) }
    }))
  })

  const [providers, pending] = await Promise.all([providersPromise, profilesPromise])

  // ZCode and Z.ai read the same endpoint and report the same plan numbers
  // whenever both credentials belong to one z.ai account: showing both is a
  // duplicate row. The deliberately configured Z.ai credential (Keychain,
  // ZAI_API_KEY, Pi) wins and the ambient ZCode app login yields — but only
  // while Z.ai is actually connected, so a rejected or stale Z.ai state never
  // hides a working ZCode row.
  const zaiRow = providers.find(row => row.id === 'zai')
  if (zaiRow?.available) {
    const zcodeIndex = providers.findIndex(row => row.id === 'zcode')
    if (zcodeIndex !== -1 && providers[zcodeIndex].available) {
      providers.splice(zcodeIndex, 1)
      zaiRow.notes = [...(zaiRow.notes ?? []), 'A ZCode app login is also connected; it reads the same z.ai plan endpoint and is hidden as a duplicate.']
    }
  }
  if (!pending) {
    return { providers }
  }
  const claudeRow = providers.find(entry => entry.id === 'claude')
  const claudeProfiles = await Promise.all(pending.map(async entry => {
    // A readers list without Claude leaves nothing to reuse, so that directory is read after all.
    const base = entry.base === REUSE_CLAUDE_ROW
      ? claudeRow ?? await readProfileBase(entry.dir, readProfile, timeoutMs)
      : entry.base
    return { ...base, id: claudeConfigSourceId(entry.dir), label: entry.label, path: entry.dir }
  }))
  return { providers, claudeProfiles }
}

function resetLabel(iso: string | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
}

function pushQuotaRows(
  rows: string[][],
  title: string,
  entry: { windows: QuotaCommandWindow[]; error?: string; notes?: string[] },
): void {
  if (entry.windows.length === 0) {
    rows.push([title, entry.error ?? 'Not connected', '', ''])
  } else {
    entry.windows.forEach((window, index) => {
      rows.push([index === 0 ? title : '', window.label, `${window.usedPct}%`, resetLabel(window.resetsAt)])
    })
  }
  // A provider with no readable window can still hold a fact worth saying.
  for (const note of entry.notes ?? []) {
    rows.push(['', note, '', ''])
  }
}

export function renderQuotaTable(report: QuotaReport, opts: { color?: boolean } = {}): string {
  const rows: string[][] = []
  const profiles = report.claudeProfiles ?? []
  let profilesPlaced = false
  for (const provider of report.providers) {
    pushQuotaRows(rows, provider.plan ? `${provider.name} (${provider.plan})` : provider.name, provider)
    // The profile rows are the Claude row split by directory, so they read directly under it
    // rather than stranded at the bottom of the table.
    if (provider.id === 'claude') {
      for (const profile of profiles) {
        pushQuotaRows(rows, `Claude (${profile.label})`, profile)
      }
      profilesPlaced = true
    }
  }
  if (!profilesPlaced) {
    for (const profile of profiles) {
      pushQuotaRows(rows, `Claude (${profile.label})`, profile)
    }
  }
  const columns = [{ header: 'Provider' }, { header: 'Window' }, { header: 'Used', right: true }, { header: 'Resets' }]
  return renderTable(columns, rows, { color: opts.color })
}
