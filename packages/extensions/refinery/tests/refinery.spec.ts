import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RefineryService from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  cleanups.length = 0
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-refinery-'))
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function service(path: string): Promise<{ svc: RefineryService; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const plugin = await ctx.plugin(RefineryService, { path })
  return { svc: ctx.refinery, dispose: () => plugin.dispose() }
}

describe('refinery service', () => {
  it('starts empty for a missing stream', async () => {
    const dir = await tempDir()
    const { svc, dispose } = await service(join(dir, 'proposals.jsonl'))
    const state = await svc.snapshot()
    expect(state.active).toEqual([])
    expect(state.total).toBe(0)
    await dispose()
  })

  it('persists a proposal and folds it back on a fresh process', async () => {
    const dir = await tempDir()
    const path = join(dir, 'proposals.jsonl')
    {
      const { svc, dispose } = await service(path)
      const proposal = await svc.propose({
        title: 'stabilize the build',
        body: 'Normalize output paths; the retry masks a path-length bug.',
        addresses: ['mem-1', 'mem-2'],
      })
      expect(proposal.id).toMatch(/^prop-/)
      expect(proposal.settled).toBeUndefined()
      await dispose()
    }
    {
      const { svc, dispose } = await service(path)
      const state = await svc.snapshot()
      expect(state.active).toHaveLength(1)
      expect(state.active[0]?.title).toBe('stabilize the build')
      expect(state.active[0]?.addresses).toEqual(['mem-1', 'mem-2'])
      await dispose()
    }
  })

  it('settle removes the proposal from the active set and records the annotation', async () => {
    const dir = await tempDir()
    const { svc, dispose } = await service(join(dir, 'proposals.jsonl'))
    const proposal = await svc.propose({ title: 't', body: 'b' })
    const settled = await svc.settle({ id: proposal.id, status: 'applied', note: 'landed' })
    expect(settled?.settled?.status).toBe('applied')
    const state = await svc.snapshot()
    expect(state.active).toEqual([])
    expect(state.total).toBe(2)
    // Settling an unknown or already settled id appends nothing.
    await expect(svc.settle({ id: proposal.id, status: 'discarded', note: 'again' })).resolves.toBeUndefined()
    const after = await svc.snapshot()
    expect(after.total).toBe(2)
    await dispose()
  })

  it('rejects an empty title, body, or note', async () => {
    const dir = await tempDir()
    const { svc, dispose } = await service(join(dir, 'proposals.jsonl'))
    await expect(svc.propose({ title: '  ', body: 'b' })).rejects.toThrow('title')
    await expect(svc.propose({ title: 't', body: '' })).rejects.toThrow('body')
    await expect(svc.settle({ id: 'prop-none', status: 'applied', note: ' ' })).rejects.toThrow('note')
    await dispose()
  })

  it('fails loud on a corrupt stream', async () => {
    const dir = await tempDir()
    const path = join(dir, 'proposals.jsonl')
    await writeFile(path, '{not json}\n', 'utf8')
    const { svc, dispose } = await service(path)
    await expect(svc.snapshot()).rejects.toThrow('invalid JSON')
    await dispose()
  })

  it('anchors the default path at the nearest .git ancestor', async () => {
    const root = await tempDir()
    const { mkdir, rm } = await import('node:fs/promises')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'nested', 'deep'), { recursive: true })
    const { resolveDefaultStreamPath } = await import('../src/index.ts')
    await expect(resolveDefaultStreamPath(join(root, 'nested', 'deep'))).resolves.toBe(join(root, '.dsh', 'refinery', 'proposals.jsonl'))
    cleanups.push(async () => {
      await rm(join(root, '.dsh'), { recursive: true, force: true })
    })
  })

  it('writes one JSONL event per line', async () => {
    const dir = await tempDir()
    const path = join(dir, 'proposals.jsonl')
    const { svc, dispose } = await service(path)
    await svc.propose({ title: 'one', body: 'first' })
    await svc.propose({ title: 'two', body: 'second' })
    await dispose()
    const text = await readFile(path, 'utf8')
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: 'propose' })
    expect(JSON.parse(lines[1] as string)).toMatchObject({ type: 'propose' })
  })
})
