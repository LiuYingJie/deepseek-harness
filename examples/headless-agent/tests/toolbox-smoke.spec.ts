import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/toolbox.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/**
 * REAL-composition keyless smoke: the Loader boots the toolbox pair plus the
 * worker-thread code runtime through a real cordis.yml, the mock model
 * publishes `shout_text` and calls it in the same session, and the durable
 * library file gains the version. Verifies the world (the JSONL stream and
 * the tool result content), not the agent's self-report.
 */
describe('headless-agent toolbox keyless smoke', () => {
  it('boots the toolbox pair through the Loader, publishes a tool, and executes it', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'headless-agent-toolbox',
      tempDirPrefix: 'headless-agent-toolbox-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'publish a shouting tool and use it'],
      tsconfigPath,
      env: {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      inspect: async (cwd) => {
        const library = await readFile(join(cwd, '.dsh-toolbox', 'toolbox.jsonl'), 'utf8')
        expect(library).toContain('"type":"publish"')
        expect(library).toContain('shout_text')
        expect(library).toContain('toUpperCase')
      },
    })
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    const result = lines.at(-1)
    expect(stderr).toBe('')
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'toolbox_publish')).toBe(true)
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'shout_text')).toBe(true)
    const shoutResult = events.find(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('HELLO TOOLBOX'))
    expect(shoutResult).toBeDefined()
    expect(String(result?.['output'])).toContain('TOOLBOX_DONE')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
