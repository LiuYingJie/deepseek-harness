import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/refinery.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/**
 * REAL-composition keyless smoke: the Loader boots the refinery pair through a
 * real cordis.yml, the mock model calls `refinery_run`, the mock subagent
 * provider settles one structured proposal, and the durable stream gains it.
 * Verifies the world (the JSONL stream), not the agent's self-report.
 */
describe('headless-agent refinery keyless smoke', () => {
  it('boots the refinery pair through the Loader and persists one proposal', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'headless-agent-refinery',
      tempDirPrefix: 'headless-agent-refinery-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'run one improvement proposal'],
      tsconfigPath,
      inspect: async (cwd) => {
        const stream = await readFile(join(cwd, '.dsh-refinery', 'proposals.jsonl'), 'utf8')
        expect(stream).toContain('"type":"propose"')
        expect(stream).toContain('stabilize the mock smoke')
      },
    })
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    const result = lines.at(-1)
    expect(stderr).toBe('')
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'refinery_run')).toBe(true)
    const toolResult = events.find(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResult)).toContain('stabilize the mock smoke')
    expect(String(result?.['output'])).toContain('REFINERY_DONE')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
