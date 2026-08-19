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

/** Keyless refinery adapter: run the refinery author once, then answer. */
class RefineryMockAdapter extends LlmAdapter {
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
    const sawRun = options.messages.some(message =>
      message.content.some(block => block.type === 'tool-call' && block.name === 'refinery_run'))
    if (!sawRun) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('refinery-smoke-1'), name: 'refinery_run', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('refinery-smoke-1'), name: 'refinery_run', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const reply = 'REFINERY_DONE'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'refinery-mock-llm'
export const inject = ['llm']

/** Register the keyless `refinery-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['refinery-mock'], new RefineryMockAdapter())
}
