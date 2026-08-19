import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolboxService, { ToolboxError, findProjectRoot, resolveDefaultLibraryPath } from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  cleanups.length = 0
})

async function tempLibrary(): Promise<{ ctx: Context; service: ToolboxService; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-toolbox-'))
  cleanups.push(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
  const path = join(dir, 'toolbox.jsonl')
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const service = new ToolboxService(ctx, { path })
  return { ctx, service, path }
}

function schema(name: string, parameters: Record<string, { type: string; required?: true }> = {}) {
  return { name, description: `test tool ${name}`, parameters }
}

describe('ToolboxService library fold', () => {
  it('starts empty and creates the file on first publish', async () => {
    const { service, path } = await tempLibrary()
    expect(await service.snapshot()).toEqual({ tools: [], total: 0 })
    const record = await service.publish({ schema: schema('echo_thing', { text: { type: 'string', required: true } }), program: 'return args.text;' })
    expect(record.id).toMatch(/^tool-[0-9a-f]{8}$/)
    expect(record.origin).toBe('agent')
    const state = await service.snapshot()
    expect(state.tools).toHaveLength(1)
    expect(state.tools[0]).toMatchObject({ name: 'echo_thing' })
    expect(state.tools[0]!.version.id).toBe(record.id)
    const text = await readFile(path, 'utf8')
    expect(text.split('\n').filter(line => line.trim() !== '')).toHaveLength(1)
  })

  it('reloads a library written by an earlier process', async () => {
    const { ctx, service, path } = await tempLibrary()
    await service.publish({ schema: schema('one_tool'), program: 'return 1;' })
    await ctx.fiber.dispose()
    const ctx2 = new Context()
    cleanups.push(async () => { await ctx2.fiber.dispose() })
    const second = new ToolboxService(ctx2, { path })
    const state = await second.snapshot()
    expect(state.tools.map(tool => tool.name)).toEqual(['one_tool'])
    expect(state.total).toBe(1)
    const retired = await second.retire('one_tool')
    expect(retired).toBe(true)
    expect((await second.snapshot()).tools).toHaveLength(0)
  })

  it('publish replaces the active version of one name', async () => {
    const { service, path } = await tempLibrary()
    const first = await service.publish({ schema: schema('calc'), program: 'return 1;' })
    const second = await service.publish({ schema: schema('calc'), program: 'return 2;' })
    expect(second.id).not.toBe(first.id)
    const state = await service.snapshot()
    expect(state.tools).toHaveLength(1)
    expect(state.tools[0]!.version.id).toBe(second.id)
    expect(state.total).toBe(2)
    const lines = (await readFile(path, 'utf8')).split('\n').filter(line => line.trim() !== '')
    expect(lines).toHaveLength(2)
  })

  it('retire on an unknown name appends nothing and reports false', async () => {
    const { service, path } = await tempLibrary()
    expect(await service.retire('missing_tool')).toBe(false)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await service.snapshot()).total).toBe(0)
  })

  it('rejects invalid names and empty programs', async () => {
    const { service } = await tempLibrary()
    await expect(service.publish({ schema: schema('Bad-Name'), program: 'return 1;' })).rejects.toMatchObject({ code: 'DUPLICATE_TOOL' })
    await expect(service.publish({ schema: schema('ok_name'), program: '   ' })).rejects.toMatchObject({ code: 'EMPTY_PROGRAM' })
  })

  it('fails loud on a corrupt library file', async () => {
    const { service, path } = await tempLibrary()
    await service.publish({ schema: schema('ok_name'), program: 'return 1;' })
    await writeFile(path, 'not-json\n', 'utf8')
    await expect(service.snapshot()).rejects.toMatchObject({ code: 'CORRUPT_LIBRARY' })
  })

  it('anchors the default library at the project root', async () => {
    const root = await findProjectRoot(process.cwd())
    expect(root).toBe(await findProjectRoot(join(root, 'packages')))
    const defaultPath = await resolveDefaultLibraryPath(process.cwd())
    expect(defaultPath).toBe(join(root, '.dsh', 'toolbox', 'toolbox.jsonl'))
  })

  it('exposes the ToolboxError code taxonomy', () => {
    const error = new ToolboxError('x', 'CORRUPT_LIBRARY')
    expect(error.name).toBe('ToolboxError')
    expect(error.code).toBe('CORRUPT_LIBRARY')
  })
})
