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

/** Whether the history already carries one tool-call of the given name. */
function called(options: GenerateOptions, name: string): boolean {
  return options.messages.some(message =>
    message.content.some(block => block.type === 'tool-call' && block.name === name))
}

/** Keyless toolbox adapter: publish a tool, call it, then answer with its output. */
class ToolboxMockAdapter extends LlmAdapter {
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
    if (!called(options, 'toolbox_publish')) {
      const args = JSON.stringify({
        name: 'shout_text',
        description: 'Uppercase the given text.',
        parameters: { text: { type: 'string', required: true } },
        program: 'return String(args.text).toUpperCase();',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('toolbox-smoke-1'), name: 'toolbox_publish', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('toolbox-smoke-1'), name: 'toolbox_publish', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (!called(options, 'shout_text')) {
      const args = JSON.stringify({ text: 'hello toolbox' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('toolbox-smoke-2'), name: 'shout_text', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('toolbox-smoke-2'), name: 'shout_text', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const last = options.messages.at(-1)?.content.at(-1)
    const toolText = last !== undefined && last.type === 'tool-result'
      ? last.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    const reply = `TOOLBOX_DONE ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'toolbox-mock-llm'
export const inject = ['llm']

/** Register the keyless `toolbox-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['toolbox-mock'], new ToolboxMockAdapter())
}
