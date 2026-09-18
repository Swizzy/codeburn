// Provider capacity readers for `codeburn quota`.
//
// These adapters were ported from the Electron desktop app's copies under
// `app/electron/quota/*.ts`, which remain the origin and are still what the
// desktop app runs. They are deliberately left untouched by this change; the
// two trees will be deduped in a follow-up once every surface reads the CLI.

import { dirname, join } from 'node:path'

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

function readClaudeProfileFrom(dir: string, signal: AbortSignal): Promise<QuotaProvider> {
  return fetchClaudeQuota({ signal, credentialPath: join(dir, '.credentials.json') }).then(result => result.quota)
}

export async function collectQuota(options: {
  readers?: { id: ProviderName; name: string; read: ProviderReader }[]
  timeoutMs?: number
  claudeConfigDirs?: string[]
  readClaudeProfile?: (dir: string, signal: AbortSignal) => Promise<QuotaProvider>
} = {}): Promise<QuotaReport> {
  const readers = options.readers ?? availableReaders()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const providers = await Promise.all(readers.map(async entry => {
    const quota = await readWithTimeout(entry.read, timeoutMs)
    if (quota === 'timeout') {
      return { id: entry.id, name: entry.name, available: false, windows: [], error: 'Timed out.' }
    }
    return toCommandProvider(entry.id, entry.name, quota)
  }))
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

  const dirs = options.claudeConfigDirs ?? await getClaudeConfigDirs()
  if (dirs.length < 2) {
    return { providers }
  }
  const readProfile = options.readClaudeProfile ?? readClaudeProfileFrom
  const labels = uniqueProfileLabels(dirs.map(dir => claudeProfileLabel(dir, dirname(dir))))
  const claudeProfiles = await Promise.all(dirs.map(async (dir, index) => {
    const quota = await readWithTimeout(signal => readProfile(dir, signal), timeoutMs)
    const base = quota === 'timeout' ? TIMED_OUT : toCommandProvider('claude', 'Claude', quota)
    return { ...base, id: claudeConfigSourceId(dir), label: labels[index], path: dir }
  }))
  return { providers, claudeProfiles }
}

function resetLabel(iso: string | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
}

export function renderQuotaTable(report: QuotaReport, opts: { color?: boolean } = {}): string {
  const rows: string[][] = []
  for (const provider of report.providers) {
    const title = provider.plan ? `${provider.name} (${provider.plan})` : provider.name
    if (provider.windows.length === 0) {
      rows.push([title, provider.error ?? 'Not connected', '', ''])
      // A provider with no readable window can still hold a fact worth saying.
      for (const note of provider.notes ?? []) rows.push(['', note, '', ''])
      continue
    }
    provider.windows.forEach((window, index) => {
      rows.push([index === 0 ? title : '', window.label, `${window.usedPct}%`, resetLabel(window.resetsAt)])
    })
    for (const note of provider.notes ?? []) rows.push(['', note, '', ''])
  }
  for (const profile of report.claudeProfiles ?? []) {
    const title = `Claude (${profile.label})`
    if (profile.windows.length === 0) {
      rows.push([title, profile.error ?? 'Not connected', '', ''])
      continue
    }
    profile.windows.forEach((window, index) => {
      rows.push([index === 0 ? title : '', window.label, `${window.usedPct}%`, resetLabel(window.resetsAt)])
    })
  }
  const columns = [{ header: 'Provider' }, { header: 'Window' }, { header: 'Used', right: true }, { header: 'Resets' }]
  return renderTable(columns, rows, { color: opts.color })
}
