import { describe, expect, it } from 'vitest'

import { expandClaudeProfiles, hasProfileRows, providerKey } from '../windows/src/lib/dockRows.js'
import type { ClaudeProfile, QuotaProvider } from '../windows/src/lib/quota.js'

const claude: QuotaProvider = { id: 'claude', name: 'Claude', available: true, windows: [{ label: 'Weekly', usedPct: 10 }] }
const codex: QuotaProvider = { id: 'codex', name: 'Codex', available: true, windows: [] }
const profiles: ClaudeProfile[] = [
  { id: 'claude-config:aa', label: 'Default', path: '/h/.claude', name: 'Claude', available: true, windows: [{ label: 'Weekly', usedPct: 10 }] },
  { id: 'claude-config:bb', label: 'Work', path: '/h/.claude-work', name: 'Claude', available: false, windows: [], error: 'Not connected' },
]

describe('expandClaudeProfiles', () => {
  it('leaves the rows alone when combined', () => {
    expect(expandClaudeProfiles([codex, claude], profiles, 'combined')).toEqual([codex, claude])
  })

  it('leaves the rows alone with fewer than two profiles', () => {
    expect(expandClaudeProfiles([claude], profiles.slice(0, 1), 'separate')).toEqual([claude])
  })

  it('replaces the claude row in place with one row per profile', () => {
    const rows = expandClaudeProfiles([codex, claude], profiles, 'separate')
    expect(rows.map(r => r.id)).toEqual(['codex', 'claude:claude-config:aa', 'claude:claude-config:bb'])
    expect(rows[1]).toMatchObject({ name: 'Default', available: true, profile: { providerId: 'claude', label: 'Default' } })
    expect(rows[2]).toMatchObject({ name: 'Work', available: false, error: 'Not connected', profile: { providerId: 'claude', label: 'Work' } })
    expect(rows[1].windows).toEqual(profiles[0].windows)
  })

  it('does nothing without a claude row to replace', () => {
    expect(expandClaudeProfiles([codex], profiles, 'separate')).toEqual([codex])
  })
})

describe('providerKey and hasProfileRows', () => {
  it('maps a profile row back to its provider', () => {
    const rows = expandClaudeProfiles([claude], profiles, 'separate')
    expect(rows.map(providerKey)).toEqual(['claude', 'claude'])
    expect(providerKey(codex)).toBe('codex')
    expect(hasProfileRows(rows)).toBe(true)
    expect(hasProfileRows([codex, claude])).toBe(false)
  })
})
