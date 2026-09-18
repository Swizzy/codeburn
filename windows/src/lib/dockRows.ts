/// The rail's rows are the CLI's providers, except that with the Claude profiles preference
/// on and two or more config directories known, the one Claude row gives way to a row per
/// directory. Pure, so the root vitest can cover it without a webview.

import type { DockClaudeProfilesMode } from './dockPrefs'
import type { ClaudeProfile, QuotaProvider } from './quota'

export type DockRow = QuotaProvider & {
  /// Set on a per-directory Claude row: which provider it belongs to for glyphs, colours,
  /// the settings deep link and the resting preference, and the caption under its ring.
  profile?: { providerId: string; label: string }
}

export function expandClaudeProfiles(
  providers: QuotaProvider[],
  profiles: ClaudeProfile[],
  mode: DockClaudeProfilesMode,
): DockRow[] {
  if (mode !== 'separate' || profiles.length < 2) {
    return providers
  }
  const at = providers.findIndex((p) => p.id === 'claude')
  if (at < 0) {
    return providers
  }
  const rows: DockRow[] = profiles.map((profile) => ({
    id: `claude:${profile.id}`,
    name: profile.label,
    available: profile.available,
    windows: profile.windows,
    ...(profile.plan ? { plan: profile.plan } : {}),
    ...(profile.error ? { error: profile.error } : {}),
    profile: { providerId: 'claude', label: profile.label },
  }))
  return [...providers.slice(0, at), ...rows, ...providers.slice(at + 1)]
}

/// The provider a row stands for: its own id, or the parent of a profile row.
export function providerKey(row: DockRow): string {
  return row.profile?.providerId ?? row.id
}

export function hasProfileRows(rows: DockRow[]): boolean {
  return rows.some((row) => row.profile !== undefined)
}
