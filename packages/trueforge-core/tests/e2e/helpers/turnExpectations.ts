/**
 * Collect and normalize an orchestrator turn so tests can compare
 * one `expected` object to one `actual` object.
 *
 * Layout of a TurnActual / TurnExpected:
 *   sendTypes     - event types from send()
 *   executeTrace  - compact projected events from execute()
 *   result        - generator return value (stripped)
 *   context       - root thread snapshot context (stripped)
 */
import type { Logger } from 'winston';
import { EventType } from '../../../src/core/events/schema';
import type { AgentThread } from '../../../src/core/runtime/AgentThread';
import type {
  AgentThreadExecutionEvent,
  AgentThreadExecutionResult,
  AgentThreadSendBatch,
  ContextMessage,
} from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import type { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import { isLLMContextMessage } from '../../../src/core/runtime/contextUtils';
import { logExecuteEvent, logSendEvent, logTurnPhase, logTurnResult } from './turnFlowLogger';

/** Placeholder substituted for the runtime-minted child thread id. */
export const CHILD_THREAD_PLACEHOLDER = '<child>';

export type ExecuteTraceRow = {
  type: string;
  thread_id: string | null;
  tool_call_id?: string;
  content?: string | null;
  title?: string;
  parent?: { thread_id: string; tool_call_id: string };
};

export type ContextRow = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
};

export type TurnResultRow = {
  output: { thread_id: string; content: string | null } | null;
  required_actions: string[];
  root_agent_error: { error: string } | null;
};

export type TurnActual = {
  sendTypes: string[];
  executeTrace: ExecuteTraceRow[];
  result: TurnResultRow;
  context: ContextRow[];
};

export type TurnExpected = TurnActual;

/** Normalize OpenAI-style content to a plain string or null for comparisons. */
function contentToString(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (content === null || content === undefined) {
    return null;
  }
  return JSON.stringify(content);
}

function projectExecuteEvent(event: AgentThreadExecutionEvent): ExecuteTraceRow {
  const threadId = 'thread_id' in event ? (event.thread_id ?? null) : null;
  const base: ExecuteTraceRow = { type: event.type, thread_id: threadId };

  switch (event.type) {
    case EventType.MODEL_MESSAGE:
      return { ...base, content: contentToString(event.content) };
    case EventType.TOOL_RESPONSE:
      return { ...base, tool_call_id: event.tool_call_id };
    case EventType.THREAD_CREATED:
      return {
        ...base,
        title: event.title,
        parent: {
          thread_id: event.parent.thread_id,
          tool_call_id: event.parent.tool_call_id,
        },
      };
    default:
      return base;
  }
}

function projectContext(context: ContextMessage[]): ContextRow[] {
  return context.map((msg): ContextRow => {
    if (!isLLMContextMessage(msg)) {
      return { role: 'approval_decision' };
    }
    if (msg.role === 'user') {
      return {
        role: 'user',
        content: contentToString(msg.content),
      };
    }
    if (msg.role === 'assistant') {
      const row: ContextRow = {
        role: 'assistant',
        content: contentToString(msg.content),
      };
      if (msg.tool_calls) {
        row.tool_calls = msg.tool_calls.map(tc => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }
      return row;
    }
    return {
      role: 'tool',
      tool_call_id: msg.tool_call_id,
      content: msg.content,
    };
  });
}

function projectResult(result: AgentThreadExecutionResult): TurnResultRow {
  return {
    output: result.output
      ? {
          thread_id: result.output.thread_id,
          content: contentToString(result.output.content),
        }
      : null,
    required_actions: result.required_actions.map(action => action.type),
    root_agent_error: result.root_agent_error ? { error: result.root_agent_error.error } : null,
  };
}

/** Drop noisy append / delta events so the trace reads as the turn story. */
export function compactExecuteTrace(trace: ExecuteTraceRow[]): ExecuteTraceRow[] {
  return trace.filter(
    row => row.type !== InternalEventType.AGENT_CONTEXT_APPEND && row.type !== EventType.MODEL_MESSAGE_DELTA,
  );
}

function normalizeChildThreadId(trace: ExecuteTraceRow[], childThreadId: string | null): ExecuteTraceRow[] {
  if (childThreadId === null) {
    return trace;
  }
  return trace.map(row => {
    if (row.thread_id !== childThreadId) {
      return row;
    }
    return { ...row, thread_id: CHILD_THREAD_PLACEHOLDER };
  });
}

/**
 * Run send() then execute() and return a normalized turn snapshot
 * suitable for expected-vs-actual comparison.
 *
 * Pass `logger` to print every event with source → destination labels
 * (see turnFlowLogger.ts).
 */
export async function runOrchestratorTurn(input: {
  orchestrator: AgentThreadOrchestrator;
  rootThread: AgentThread;
  sendBatch: AgentThreadSendBatch;
  signal?: AbortSignal | undefined;
  logger?: Logger | undefined;
}): Promise<TurnActual> {
  const { logger } = input;

  if (logger) {
    logTurnPhase(logger, 'send', 'append user/tool input into thread context (no LLM call)');
  }

  const sendTypes: string[] = [];
  for await (const event of input.orchestrator.send(input.sendBatch)) {
    sendTypes.push(event.type);
    if (logger) {
      logSendEvent(logger, event);
    }
  }

  if (logger) {
    logTurnPhase(logger, 'execute', 'run leaf threads; orchestrator merges streams and routes sub-agents');
  }

  const rawExecuteTrace: ExecuteTraceRow[] = [];
  const iterator = input.orchestrator.execute({
    signal: input.signal ?? new AbortController().signal,
  });

  let step = await iterator.next();
  let executeIndex = 0;
  while (!step.done) {
    if (logger) {
      logExecuteEvent(logger, step.value, executeIndex);
      executeIndex += 1;
    }
    rawExecuteTrace.push(projectExecuteEvent(step.value));
    step = await iterator.next();
  }

  if (logger) {
    logTurnPhase(logger, 'result', 'generator return value (not a streamed event)');
    logTurnResult(logger, step.value);
  }

  const childThreadId = rawExecuteTrace.find(row => row.type === EventType.THREAD_CREATED)?.thread_id ?? null;

  return {
    sendTypes,
    executeTrace: normalizeChildThreadId(compactExecuteTrace(rawExecuteTrace), childThreadId),
    result: projectResult(step.value),
    context: projectContext(input.rootThread.toSnapshot().context),
  };
}

/** Layered compare so a failure names sendTypes / executeTrace / result / context. */
export function expectTurn(actual: TurnActual, expected: TurnExpected): void {
  expect(actual.sendTypes).toEqual(expected.sendTypes);
  expect(actual.executeTrace).toEqual(expected.executeTrace);
  expect(actual.result).toEqual(expected.result);
  expect(actual.context).toEqual(expected.context);
}
