import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryService, { MemoryLedgerError, findProjectRoot, resolveDefaultLedgerPath } from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  cleanups.length = 0
})

async function tempLedger(): Promise<{ ctx: Context; service: MemoryService; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
  const path = join(dir, 'ledger.jsonl')
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const service = new MemoryService(ctx, { path })
  return { ctx, service, path }
}

describe('MemoryService ledger fold', () => {
  it('starts empty and creates the file on first add', async () => {
    const { service, path } = await tempLedger()
    expect(await service.snapshot()).toEqual({ active: [], total: 0 })
    const record = await service.add({ kind: 'problem', title: '  flaky test on windows  ' })
    expect(record.title).toBe('flaky test on windows')
    expect(record.id).toMatch(/^mem-[0-9a-f]{8}$/)
    const state = await service.snapshot()
    expect(state.active).toHaveLength(1)
    expect(state.active[0]).toMatchObject({ kind: 'problem', title: 'flaky test on windows', origin: 'agent' })
    const text = await readFile(path, 'utf8')
    expect(text.split('\n').filter(line => line.trim() !== '')).toHaveLength(1)
  })

  it('reloads a ledger written by an earlier process', async () => {
    const { ctx, service, path } = await tempLedger()
    const first = await service.add({ kind: 'problem', title: 'p1' })
    await service.add({ kind: 'lesson', title: 'l1', origin: 'auto', sessionId: 'sess-1' })
    await ctx.fiber.dispose()
    const ctx2 = new Context()
    cleanups.push(async () => { await ctx2.fiber.dispose() })
    const second = new MemoryService(ctx2, { path })
    const state = await second.snapshot()
    expect(state.active.map(record => record.title)).toEqual(['p1', 'l1'])
    expect(state.total).toBe(2)
    const resolved = await second.resolve({ id: first.id, note: 'fixed in PR 42' })
    expect(resolved).toMatchObject({ id: first.id, resolved: { note: 'fixed in PR 42' } })
    expect((await second.snapshot()).active.map(record => record.title)).toEqual(['l1'])
  })

  it('resolve on unknown or already-resolved ids appends nothing', async () => {
    const { service, path } = await tempLedger()
    const record = await service.add({ kind: 'problem', title: 'p1' })
    expect(await service.resolve({ id: 'mem-unknown00', note: 'n' })).toBeUndefined()
    expect(await service.resolve({ id: record.id, note: 'first' })).toBeDefined()
    expect(await service.resolve({ id: record.id, note: 'second' })).toBeUndefined()
    const text = await readFile(path, 'utf8')
    expect(text.split('\n').filter(line => line.trim() !== '')).toHaveLength(2)
  })

  it('rejects empty titles and notes', async () => {
    const { service } = await tempLedger()
    await expect(service.add({ kind: 'problem', title: '   ' })).rejects.toThrow('non-empty')
    const record = await service.add({ kind: 'problem', title: 'p' })
    await expect(service.resolve({ id: record.id, note: '  ' })).rejects.toThrow('non-empty')
  })

  it('fails loud on a corrupt ledger line', async () => {
    const { service, path } = await tempLedger()
    await service.add({ kind: 'problem', title: 'p1' })
    await writeFile(path, '{"type":"open","record":{"id":"mem-x"\n', 'utf8')
    await expect(service.snapshot()).rejects.toBeInstanceOf(MemoryLedgerError)
  })

  it('drops blank detail instead of persisting whitespace', async () => {
    const { service } = await tempLedger()
    const record = await service.add({ kind: 'lesson', title: 'l1', detail: '   ' })
    expect(record.detail).toBeUndefined()
  })
})

describe('project root anchoring', () => {
  it('finds the nearest .git ancestor and anchors there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-root-'))
    cleanups.push(async () => {
      const { rm } = await import('node:fs/promises')
      await rm(dir, { recursive: true, force: true })
    })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'packages/inner'), { recursive: true })
    expect(await findProjectRoot(join(dir, 'packages/inner'))).toBe(dir)
    expect(await resolveDefaultLedgerPath(join(dir, 'packages/inner'))).toBe(join(dir, '.dsh', 'memory', 'ledger.jsonl'))
  })

  it('anchors at the start directory when no .git ancestor exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-nogit-'))
    cleanups.push(async () => {
      const { rm } = await import('node:fs/promises')
      await rm(dir, { recursive: true, force: true })
    })
    expect(await findProjectRoot(dir)).toBe(dir)
  })
})
