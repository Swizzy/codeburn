import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { claudeConfigSourceId } from '../src/providers/claude.js'
import { claudeProfileLabel, uniqueProfileLabels } from '../src/quota/claude.js'

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
