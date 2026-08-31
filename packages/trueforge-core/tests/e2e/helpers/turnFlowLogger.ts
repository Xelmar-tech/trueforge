/**
 * Human-readable turn flow logging for e2e learning.
 * Labels which component emitted each event and where it goes next.
 */
import type { Logger } from 'winston';
import { EventType } from '../../../src/core/events/schema';
import type {
  AgentThreadAppendContext,
  AgentThreadExecutionEvent,
  AgentThreadExecutionResult,
} from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';

type FlowPhase = 'send' | 'execute' | 'result';

function threadLabel(threadId: string | null | undefined): string {
  if (threadId === null || threadId === undefined) {
    return '(no thread)';
  }
  return `AgentThread(${threadId})`;
}

function contentPreview(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content.length > 80 ? `${content.slice(0, 80)}…` : content;
  }
  if (content === null || content === undefined) {
    return undefined;
  }
  return JSON.stringify(content).slice(0, 80);
}

function describeSendEvent(event: AgentThreadAppendContext): {
  flow: string;
  detail: Record<string, unknown>;
} {
  return {
    flow: `Test → Orchestrator.send → ${threadLabel(event.thread_id)}.send`,
    detail: {
      type: event.type,
      thread_id: event.thread_id,
      appended_roles: event.context.map(m => ('role' in m ? m.role : 'approval')),
      output_types: event.output.map(o => o.type),
    },
  };
}

function describeExecuteEvent(event: AgentThreadExecutionEvent): {
  flow: string;
  detail: Record<string, unknown>;
} {
  const threadId = 'thread_id' in event ? event.thread_id : null;

  switch (event.type) {
    case EventType.MODEL_MESSAGE:
      return {
        flow: `${threadLabel(threadId)} → Orchestrator → Test`,
        detail: {
          type: event.type,
          thread_id: threadId,
          note: 'Empty shell starts the stream; text arrives later via deltas / context.append',
          content: contentPreview(event.content) ?? null,
        },
      };
    case EventType.MODEL_MESSAGE_DELTA:
      return {
        flow: `${threadLabel(threadId)} → Orchestrator → Test`,
        detail: {
          type: event.type,
          thread_id: threadId,
          content: contentPreview(event.content),
          tool_call_names: event.tool_calls?.map(tc => tc.function?.name).filter(Boolean),
        },
      };
    case InternalEventType.AGENT_CONTEXT_APPEND:
      return {
        flow: `${threadLabel(event.thread_id)} → Orchestrator → Test (durable append)`,
        detail: {
          type: event.type,
          thread_id: event.thread_id,
          appended_roles: event.context.map(m => ('role' in m ? m.role : 'approval')),
          output_types: event.output.map(o => o.type),
          has_completion: Boolean(event.completion),
        },
      };
    case EventType.THREAD_CREATED:
      return {
        flow: `Orchestrator.createDynamicSubAgentThread → new ${threadLabel(event.thread_id)} (registered in map)`,
        detail: {
          type: event.type,
          thread_id: event.thread_id,
          title: event.title,
          parent: event.parent,
          agent_info: event.agent_info,
          note: 'Internal AGENT_CREATE_SUBAGENT was swallowed; this is what the consumer sees',
        },
      };
    case EventType.TOOL_RESPONSE:
      return {
        flow: `Orchestrator → ${threadLabel(threadId)}.send (child result routed to parent tool call)`,
        detail: {
          type: event.type,
          thread_id: threadId,
          tool_call_id: event.tool_call_id,
          content: contentPreview(event.content),
        },
      };
    case InternalEventType.AGENT_DONE: {
      const isChild = Boolean(event.parent);
      return {
        flow: isChild
          ? `${threadLabel(threadId)} → Orchestrator (child done; parent will resume)`
          : `${threadLabel(threadId)} → Orchestrator → Test (root done; execute stops)`,
        detail: {
          type: event.type,
          thread_id: threadId,
          status: event.status,
          parent: event.parent ?? null,
          output_preview: contentPreview(event.output?.content),
          send_to_parent: event.send_to_parent
            ? {
                tool_call_id: event.send_to_parent.tool_call_id,
                content: contentPreview(event.send_to_parent.content),
              }
            : null,
        },
      };
    }
    case EventType.TOOL_APPROVAL_REQUIRED:
    case EventType.TOOL_RESPONSE_REQUIRED:
      return {
        flow: `${threadLabel(threadId)} → Orchestrator → Test (pause; wait for user send)`,
        detail: { type: event.type, thread_id: threadId },
      };
    case InternalEventType.MCP_AUTH_REQUIRED:
      return {
        flow: `Orchestrator → Test (auth pause)`,
        detail: { type: event.type },
      };
    default:
      return {
        flow: `${threadLabel(threadId)} → Orchestrator → Test`,
        detail: { type: event.type, thread_id: threadId },
      };
  }
}

function describeResult(result: AgentThreadExecutionResult): {
  flow: string;
  detail: Record<string, unknown>;
} {
  return {
    flow: 'Orchestrator.execute return → Test',
    detail: {
      output_thread_id: result.output?.thread_id ?? null,
      output_content: contentPreview(result.output?.content) ?? null,
      required_actions: result.required_actions.map(a => a.type),
      root_agent_error: result.root_agent_error?.error ?? null,
    },
  };
}

export function logTurnPhase(logger: Logger, phase: FlowPhase, message: string): void {
  logger.info(`──────── ${phase.toUpperCase()} ──────── ${message}`);
}

export function logSendEvent(logger: Logger, event: AgentThreadAppendContext): void {
  const { flow, detail } = describeSendEvent(event);
  logger.info(`[send] ${flow}`, detail);
}

export function logExecuteEvent(logger: Logger, event: AgentThreadExecutionEvent, index: number): void {
  const { flow, detail } = describeExecuteEvent(event);
  logger.info(`[execute #${String(index)}] ${flow}`, detail);
}

export function logTurnResult(logger: Logger, result: AgentThreadExecutionResult): void {
  const { flow, detail } = describeResult(result);
  logger.info(`[result] ${flow}`, detail);
}
