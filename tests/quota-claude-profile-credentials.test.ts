import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QuotaProvider } from '../src/quota/types.js'

// The wiring under test is which options the profile reader hands the Claude adapter, so the
// adapter itself is replaced and everything else in its module is kept.
const { fetchClaudeQuota } = vi.hoisted(() => ({ fetchClaudeQuota: vi.fn() }))

vi.mock('../src/quota/claude.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/quota/claude.js')>()
  return { ...actual, fetchClaudeQuota }
})

const { readClaudeProfileFrom } = await import('../src/quota/index.js')

const connected: QuotaProvider = {
  provider: 'claude', connection: 'connected',
  primary: { label: 'Weekly', percent: 0.25, resetsAt: null },
  details: [{ label: 'Weekly', percent: 0.25, resetsAt: null }],
  planLabel: 'Max 5x', footerLines: [],
}

describe('readClaudeProfileFrom', () => {
  beforeEach(() => {
    fetchClaudeQuota.mockReset()
    fetchClaudeQuota.mockResolvedValue({ quota: connected })
  })

  it('asks the adapter for that directory credential file, with the caller signal', async () => {
    const dir = join('C:\\Users\\me', '.claude-work')
    const controller = new AbortController()
    await expect(readClaudeProfileFrom(dir, controller.signal)).resolves.toEqual(connected)
    expect(fetchClaudeQuota).toHaveBeenCalledTimes(1)
    const options = fetchClaudeQuota.mock.calls[0][0]
    expect(options.credentialPath).toBe(join(dir, '.credentials.json'))
    expect(options.signal).toBe(controller.signal)
  })

  it('never opens the keychain, which holds the default directory token only', async () => {
    await readClaudeProfileFrom('/tmp/.claude-work', new AbortController().signal)
    const options = fetchClaudeQuota.mock.calls[0][0]
    expect('allowKeychain' in options).toBe(false)
  })
})
