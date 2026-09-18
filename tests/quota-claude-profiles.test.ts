import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { claudeConfigSourceId } from '../src/providers/claude.js'
import { claudeProfileLabel, uniqueProfileLabels } from '../src/quota/claude.js'
import { collectQuota, renderQuotaTable } from '../src/quota/index.js'
import type { QuotaProvider } from '../src/quota/types.js'
import { setHome } from './setup/home.js'

const HOME = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'

describe('claudeProfileLabel', () => {
  it('names the default directory Default', () => {
    expect(claudeProfileLabel(join(HOME, '.claude'), HOME)).toBe('Default')
  })

  it('strips the dot and the claude- prefix and capitalises the rest', () => {
    expect(claudeProfileLabel(join(HOME, '.claude-work'), HOME)).toBe('Work')
    expect(claudeProfileLabel(join(HOME, 'claude-personal'), HOME)).toBe('Personal')
    expect(claudeProfileLabel(join(HOME, '.acme'), HOME)).toBe('Acme')
  })

  it('falls back to the full path when nothing is left', () => {
    expect(claudeProfileLabel(join(HOME, '.claude-'), HOME)).toBe(join(HOME, '.claude-'))
  })
})

describe('uniqueProfileLabels', () => {
  it('leaves distinct labels alone', () => {
    expect(uniqueProfileLabels(['Default', 'Work'])).toEqual(['Default', 'Work'])
  })

  it('numbers duplicates in list order', () => {
    expect(uniqueProfileLabels(['Work', 'Default', 'Work'])).toEqual(['Work 1', 'Default', 'Work 2'])
  })
})

describe('claudeConfigSourceId', () => {
  it('is the popover picker id: claude-config plus sixteen hex chars', () => {
    expect(claudeConfigSourceId('/x')).toMatch(/^claude-config:[0-9a-f]{16}$/)
    expect(claudeConfigSourceId('/x')).toBe(claudeConfigSourceId('/x'))
    expect(claudeConfigSourceId('/x')).not.toBe(claudeConfigSourceId('/y'))
  })
})

function connected(percent: number): QuotaProvider {
  return {
    provider: 'claude', connection: 'connected',
    primary: { label: 'Weekly', percent, resetsAt: null },
    details: [{ label: 'Weekly', percent, resetsAt: null }],
    planLabel: 'Max 5x', footerLines: [],
  }
}

describe('collectQuota Claude profiles', () => {
  const dirs = [join(HOME, '.claude'), join(HOME, '.claude-work')]

  beforeEach(() => setHome(HOME))

  it('emits one profile per config dir, keyed and labelled, when there are two or more', async () => {
    const seen: string[] = []
    const report = await collectQuota({
      readers: [],
      claudeConfigDirs: dirs,
      readClaudeProfile: async dir => { seen.push(dir); return connected(dir.endsWith('work') ? 0.4 : 0.1) },
    })
    expect(seen).toEqual(dirs)
    expect(report.claudeProfiles?.map(p => [p.id, p.label, p.path, p.available, p.plan, p.windows[0]?.usedPct])).toEqual([
      [claudeConfigSourceId(dirs[0]), 'Default', dirs[0], true, 'Max 5x', 10],
      [claudeConfigSourceId(dirs[1]), 'Work', dirs[1], true, 'Max 5x', 40],
    ])
  })

  it('omits the key with a single config dir and never reads it', async () => {
    let reads = 0
    const report = await collectQuota({
      readers: [],
      claudeConfigDirs: [dirs[0]],
      readClaudeProfile: async () => { reads += 1; return connected(0.1) },
    })
    expect(report.claudeProfiles).toBeUndefined()
    expect(reads).toBe(0)
  })

  it('times a slow profile out on its own, leaving the other intact', async () => {
    const report = await collectQuota({
      readers: [],
      timeoutMs: 20,
      claudeConfigDirs: dirs,
      readClaudeProfile: (dir) => {
        if (dir.endsWith('work')) {
          return new Promise(() => {})
        }
        return Promise.resolve(connected(0.2))
      },
    })
    expect(report.claudeProfiles?.map(p => [p.label, p.available, p.error])).toEqual([
      ['Default', true, undefined],
      ['Work', false, 'Timed out.'],
    ])
  })

  it('prints a table row per profile, under the Claude row, only when profiles are present', () => {
    const base = { id: 'claude' as const, name: 'Claude', available: true, windows: [{ label: 'Weekly', usedPct: 10 }] }
    const kimi = { id: 'kimi' as const, name: 'Kimi', available: true, windows: [{ label: 'Weekly', usedPct: 5 }] }
    const without = renderQuotaTable({ providers: [base, kimi] }, { color: false })
    expect(without).not.toContain('Claude (Work)')
    const withProfiles = renderQuotaTable({
      providers: [base, kimi],
      claudeProfiles: [
        { ...base, label: 'Default', path: dirs[0] },
        { ...base, label: 'Work', path: dirs[1], windows: [{ label: 'Weekly', usedPct: 40 }] },
      ],
    }, { color: false })
    // The rendered rows sit between the header rule and the closing bar, one per window.
    const titles = withProfiles.split('\n').slice(3, -1).map(line => line.split('│')[1].trim())
    expect(titles).toEqual(['Claude', 'Claude (Default)', 'Claude (Work)', 'Kimi'])
    expect(withProfiles).toContain('40%')
  })

  it('reuses the Claude row for the default directory instead of reading it twice', async () => {
    let reads = 0
    const report = await collectQuota({
      readers: [{
        id: 'claude', name: 'Claude',
        read: async () => { reads += 1; return connected(0.1) },
      }],
      claudeConfigDirs: dirs,
    })
    // One read for the `claude` row, one for the work directory: the default directory is
    // the same credential the row already asked about.
    expect(reads).toBe(1)
    const [first, second] = report.claudeProfiles ?? []
    expect([first?.label, first?.available, first?.plan, first?.windows]).toEqual([
      'Default', true, 'Max 5x', [{ label: 'Weekly', usedPct: 10 }],
    ])
    expect(first?.id).toBe(claudeConfigSourceId(dirs[0]))
    expect(first?.path).toBe(dirs[0])
    // The work directory has no credential under this fake home, so it reads as disconnected.
    expect(second?.label).toBe('Work')
  })
})
