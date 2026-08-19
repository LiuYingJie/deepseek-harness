import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/memory.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/**
 * REAL-composition keyless smoke: the Loader boots the memory pair through a
 * real cordis.yml, the mock model calls `memory_record`, and the durable
 * ledger file gains the record. Verifies the world (the JSONL stream), not
 * the agent's self-report.
 */
describe('headless-agent memory keyless smoke', () => {
  it('boots the memory pair through the Loader and persists a recorded problem', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'headless-agent-memory',
      tempDirPrefix: 'headless-agent-memory-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'record the flaky build problem'],
      tsconfigPath,
      inspect: async (cwd) => {
        const ledger = await readFile(join(cwd, '.dsh-memory', 'ledger.jsonl'), 'utf8')
        expect(ledger).toContain('"kind":"problem"')
        expect(ledger).toContain('flaky build on windows')
      },
    })
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    const result = lines.at(-1)
    expect(stderr).toBe('')
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'memory_record')).toBe(true)
    const toolResult = events.find(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResult)).toContain('flaky build on windows')
    expect(String(result?.['output'])).toContain('MEMORY_RECORDED')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
