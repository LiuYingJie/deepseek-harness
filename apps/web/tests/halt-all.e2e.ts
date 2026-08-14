// Keyless browser coverage for Halt all: hang one turn, queue follow-ups,
// then prove Stop all clears Queue and does not start the next queued turn.
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/halt-all', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const QUEUED_EXPECTED = join(SNAPSHOT_DIR, 'queued.expected.md')
const MODE = webSnapshotMode()

const ACTIVE_PROMPT = 'Reply with a one-sentence description of event sourcing, then stop.'
const QUEUED = 'Queued follow-up after halt'
const TAIL = 'Second queued follow-up after halt'

/** Durable turn-end classifications observed by the scenario. */
function turnEndReasons(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

describe('web e2e: Halt all', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let overrideDir: string | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (overrideDir !== undefined) {
      await rm(overrideDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    overrideDir = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'halt-all teardown failed')
  })

  it.skipIf(MODE === 'record')('clears Queue and does not start the next queued turn', async () => {
    overrideDir = await mkdtemp(join(tmpdir(), 'dsh-web-halt-all-'))
    const readyFile = join(overrideDir, '.hang-ready')
    const overridePath = join(overrideDir, 'replay.override.json')
    await writeFile(overridePath, JSON.stringify([{ kind: 'hang', readyFile } satisfies ReplayEntry]))

    const sessionEvents: SessionEvent[] = []
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: overridePath })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-halt-all'))

    const input = page.locator('textarea').first()
    const firstSettled = scaffold.whenTurnSettled()
    await input.fill(ACTIVE_PROMPT)
    await input.press('Enter')
    await expect.poll(() => existsSync(readyFile), { timeout: 15_000 }).toBe(true)

    for (const text of [QUEUED, TAIL]) {
      await input.fill(text)
      await input.press('Enter')
    }
    const queueHeader = page.getByRole('button', { name: '2 queued messages' })
    await expect.poll(() => queueHeader.getAttribute('aria-expanded'), { timeout: 10_000 })
      .toBe('false')
    await page.getByRole('button', { name: 'Stop all' }).waitFor()

    const queuedSnapshot = await captureStableAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(QUEUED_EXPECTED, queuedSnapshot, MODE)

    await page.getByRole('button', { name: 'Stop all' }).click()
    await firstSettled
    await expect.poll(() => page.getByRole('button', { name: 'Stop all' }).count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: 'Stop generating' }).count()).toBe(0)
    await expect.poll(() => page.locator('[data-queue-dock]').count()).toBe(0)
    await expect.poll(() => turnEndReasons(sessionEvents), { timeout: 15_000 })
      .toEqual(['aborted'])
    expect(sessionEvents.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])).toEqual([ACTIVE_PROMPT])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['queued.expected.md'])
  })
})
