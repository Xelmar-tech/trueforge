import type { ILLM } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';

/** One streamed chunk plus a stop completion. Used when the test needs a text reply and no tool calls. */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
export async function* textReplyStream(
  text: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-text',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: text },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

/** ILLM that always streams `text` and then stops. */
export function makeTextLlm(text: string): ILLM {
  return {
    create: jest.fn().mockImplementation(() => textReplyStream(text)),
    createNonStream: jest.fn().mockImplementation(() => textReplyStream(text)),
  };
}
