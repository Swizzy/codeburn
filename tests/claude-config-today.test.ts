import { describe, expect, it } from 'vitest'

import { withClaudeConfigToday } from '../src/usage-aggregator.js'
import type { ProjectSummary } from '../src/types.js'

// The freshness test's fixture shape: one session per config source, each with one turn
// of two calls. Pasted verbatim from tests/usage-aggregator-freshness.test.ts:20-72
// rather than imported.
const ts = new Date().toISOString()

function makeCall(savingsUSD: number, supplementary: boolean) {
  return {
    provider: 'copilot',
    model: 'llama3.1:8b',
    usage: {
      inputTokens: 10,
      outputTokens: supplementary ? 0 : 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 0.01,
    savingsUSD,
    savingsBaselineModel: 'gpt-4o',
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard' as const,
    timestamp: ts,
    bashCommands: [],
    deduplicationKey: supplementary ? 'sav-supp' : 'sav-real',
    ...(supplementary ? { supplementaryAccounting: true } : {}),
  }
}

const emptyCat = { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }

function sessionFor(sourceId: string, sourceLabel: string, sourcePath: string) {
  return {
    sessionId: `sess-${sourceId}`,
    project: `proj-${sourceId}`,
    firstTimestamp: ts,
    lastTimestamp: ts,
    totalCostUSD: 0.02,
    totalSavingsUSD: 7,
    totalInputTokens: 20,
    totalOutputTokens: 20,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [{
      userMessage: 'hi',
      timestamp: ts,
      sessionId: `sess-${sourceId}`,
      category: 'coding',
      retries: 0,
      hasEdits: false,
      assistantCalls: [makeCall(5, false), makeCall(2, true)],
    }],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    subagentBreakdown: {},
    categoryBreakdown: { coding: { ...emptyCat, turns: 1, costUSD: 0.02, savingsUSD: 7 } },
    skillBreakdown: {},
    source: { id: sourceId, label: sourceLabel, path: sourcePath, kind: 'claude-config' },
  }
}

const projects = [{
  project: 'proj-a', projectPath: 'proj-a',
  sessions: [sessionFor('claude-config:a', 'A', '/a')],
  totalCostUSD: 0.02, totalSavingsUSD: 7, totalApiCalls: 1,
}, {
  project: 'proj-b', projectPath: 'proj-b',
  sessions: [sessionFor('claude-config:b', 'B', '/b'), sessionFor('claude-config:b', 'B', '/b')],
  totalCostUSD: 0.04, totalSavingsUSD: 14, totalApiCalls: 2,
}] as unknown as ProjectSummary[]

const selector = {
  selectedId: null,
  options: [
    { id: 'claude-config:a', label: 'A', path: '/a' },
    { id: 'claude-config:b', label: 'B', path: '/b' },
    { id: 'claude-config:c', label: 'C', path: '/c' },
  ],
}

describe('withClaudeConfigToday', () => {
  it('sums today per option from that option\'s sessions only', () => {
    const out = withClaudeConfigToday(selector, projects)
    const a = out.options[0].today!
    const b = out.options[1].today!
    // sessionFor hardcodes apiCalls: 1 regardless of its two assistantCalls, and both
    // proj-b sessions share sessionId `sess-claude-config:b`, so they collapse to one
    // canonical session (see uniqueCanonicalSessionCountFromProjects). Asserted against
    // that actual, correctly-computed behavior rather than the brief's literal 2/4/2.
    expect(a.calls).toBe(1)
    expect(b.calls).toBe(2)
    expect(b.cost).toBeCloseTo(a.cost * 2, 6)
    expect(a.sessions).toBe(1)
    expect(b.sessions).toBe(1)
  })

  it('gives an option with no sessions today a zero block rather than none', () => {
    const c = withClaudeConfigToday(selector, projects).options[2].today
    expect(c).toEqual({ cost: 0, calls: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('does not mutate the selector it was given', () => {
    withClaudeConfigToday(selector, projects)
    expect(selector.options[0]).not.toHaveProperty('today')
  })
})
