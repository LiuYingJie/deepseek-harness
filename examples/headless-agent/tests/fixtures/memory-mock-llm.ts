import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')

/** Keyless memory adapter: record, list, then a final answer naming the ledger contents. */
class MemoryMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: OFF, name: 'Off' }],
        defaultEffort: OFF,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)?.content.at(-1)
    if (last?.type !== 'tool-result') {
      const args = JSON.stringify({
        kind: 'problem',
        title: 'flaky build on windows',
        detail: 'retry resolved it twice',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('memory-smoke-1'), name: 'memory_record', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('memory-smoke-1'), name: 'memory_record', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const toolText = last.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `MEMORY_RECORDED ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'memory-mock-llm'
export const inject = ['llm']

/** Register the keyless `memory-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['memory-mock'], new MemoryMockAdapter())
}
