import type { Logger } from 'winston';
import winston from 'winston';
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

export async function* createSubAgentStream() {
  yield {
    id: 'chunk-tool',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    // Choices
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          // Tool Calls
          tool_calls: [
            {
              index: 0,
              id: 'call-sub',
              type: 'function',
              function: {
                name: 'create_sub_agent',
                arguments: JSON.stringify({ name: 'worker', input: 'do the delegated task' }),
              },
            },
          ], // tool calls end
        }, // Delta end
        finish_reason: 'tool_calls',
      },
    ], // Choices end
  }; // yeild end

  return {
    output: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-sub',
          type: 'function',
          function: {
            name: 'create_sub_agent',
            arguments: JSON.stringify({ name: 'worker', input: 'do the delegated task [output]' }),
          }, // Function end
        },
      ], // Tool calls end
    }, // Output end
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
} // function end

/** ILLM that always streams `text` and then stops. */
export function makeTextLLM(text: string): ILLM {
  return {
    create: jest.fn().mockImplementation(() => textReplyStream(text)),
    createNonStream: jest.fn().mockImplementation(() => textReplyStream(text)),
  };
}

export function makeRootLLM(finalReply: string): ILLM {
  return {
    create: jest
      .fn()
      .mockImplementationOnce(() => createSubAgentStream())
      .mockImplementation(() => textReplyStream(finalReply)),
    createNonStream: jest.fn(),
  };
}

export function makeDummyLogger(): Logger {
  const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ level, message, ...meta }) => {
        const details = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
        return `${level}: ${String(message)}${details}`;
      }),
    ),
    transports: [new winston.transports.Console()],
  });
  logger.child = () => logger;
  return logger;
}
