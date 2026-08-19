// dsh-agent.mjs — registry-based DeepSeek Harness subagent runner.
// Usage:
//   node dsh-agent.mjs "<task>"           create a new agent, prints AGENT_ID
//   node dsh-agent.mjs <ID> "<task>"      reuse an existing agent (carries its history)
//   node dsh-agent.mjs --list             list all agents
// References: a task may contain @<ID> which expands to that agent's latest output.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = 'D:\\projectOther\\deepseek-harness'
const ROOT = join(homedir(), '.dsh-agents')
const REGISTRY = join(ROOT, 'registry.json')
const MAX_RESULT_CHARS = 6000
const MAX_HISTORY_ROUNDS = 10

function loadRegistry() {
  if (!existsSync(REGISTRY)) return {}
  try {
    return JSON.parse(readFileSync(REGISTRY, 'utf8'))
  } catch {
    return {}
  }
}

function saveRegistry(reg) {
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2))
}

function outputPath(id) {
  return join(ROOT, id, 'output.txt')
}

function readHistory(id) {
  const p = join(ROOT, id, 'history.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function expandRefs(task, registry) {
  return task.replace(/@([A-Za-z0-9-]+)/g, (match, id) => {
    const out = outputPath(id)
    if (!existsSync(out)) return `[agent ${id}: no output yet]`
    const text = readFileSync(out, 'utf8').trim()
    return `\n--- latest output of agent ${id} ---\n${text.slice(0, MAX_RESULT_CHARS)}\n--- end ---`
  })
}

function buildContext(id, task) {
  const rounds = readHistory(id)
  if (rounds.length === 0) return task
  const parts = rounds
    .slice(-MAX_HISTORY_ROUNDS)
    .map((r) => `[round] task: ${r.task}\nresult: ${(r.result || '').slice(0, MAX_RESULT_CHARS)}`)
  return (
    `You are continuing an existing agent session (id ${id}). Previous rounds:\n` +
    parts.join('\n\n') +
    `\n\nNew request: ${task}`
  )
}

function list() {
  const reg = loadRegistry()
  const ids = Object.keys(reg).sort()
  if (ids.length === 0) {
    console.log('(no agents yet)')
    return
  }
  for (const id of ids) {
    const r = reg[id]
    const status = r.lastExit === 0 ? 'ok   ' : 'fail '
    const ts = (r.updatedAt || '').slice(0, 19)
    console.log(`${id}\t${status}\t${ts}\t${r.lastTask || ''}`)
  }
}

function usage() {
  console.error('usage: dsh-agent "<task>" | dsh-agent <ID> "<task>" | dsh-agent --list')
}

const args = process.argv.slice(2)
if (args.length === 0) {
  usage()
  process.exit(2)
}
if (args[0] === '--list') {
  list()
  process.exit(0)
}

let id, task
if (args.length === 1) {
  id = 'agent-' + randomBytes(3).toString('hex')
  task = args[0]
} else {
  id = args[0]
  task = args[1]
  if (!existsSync(join(ROOT, id, 'history.jsonl'))) {
    console.error(
      `[dsh-agent] unknown id "${id}". Run "dsh-agent --list" to see existing agents, ` +
        `or run without an id to create a new one.`,
    )
    process.exit(2)
  }
}

mkdirSync(join(ROOT, id), { recursive: true })
const registry = loadRegistry()
const finalTask = buildContext(id, expandRefs(task, registry))

const bin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const res = spawnSync(bin, ['dsh', '--profile', 'headless', finalTask], {
  cwd: REPO,
  encoding: 'utf8',
})
const stdout = (res.stdout || '').trim()
const stderr = (res.stderr || '').trim()
const status = res.status ?? 1

appendFileSync(
  join(ROOT, id, 'history.jsonl'),
  JSON.stringify({ ts: new Date().toISOString(), task, exit: status, result: stdout.slice(0, 20000) }) + '\n',
)
writeFileSync(outputPath(id), stdout)
registry[id] = {
  id,
  createdAt: registry[id]?.createdAt ?? new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastTask: task.slice(0, 120),
  lastExit: status,
}
saveRegistry(registry)

process.stdout.write(stdout + '\n')
process.stdout.write(`\n===== AGENT_ID=${id} =====\n`)
if (stderr) process.stderr.write(stderr + '\n')
process.exit(status)
