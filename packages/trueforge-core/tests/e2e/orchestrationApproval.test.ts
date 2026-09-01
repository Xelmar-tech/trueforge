import type { AgentDefinition } from '../../src/core';
import { EventType } from '../../src/core/events/schema';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType, type AgentThreadConstructorInput } from '../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import {
  makeApprovalGatedWriteNoteToolSet,
  makeApprovalThenTextLLM,
  makeDummyLogger,
  WRITE_NOTE_ARGUMENTS,
  WRITE_NOTE_CALL_ID,
  WRITE_NOTE_RESULT,
  WRITE_NOTE_TOOL_NAME,
} from './helpers/helpers';
import { expectTurn, runOrchestratorTurn } from './helpers/turnExpectations';

const ROOT_ID = 'thread_root';
const ROOT_FINAL = 'note saved';

const EXPECTED_PAUSE = {
  sendTypes: [InternalEventType.AGENT_CONTEXT_APPEND],
  executeTrace: [
    {
      type: EventType.MODEL_MESSAGE,
      thread_id: ROOT_ID,
      content: null,
    },
    {
      type: EventType.TOOL_APPROVAL_REQUIRED,
      thread_id: ROOT_ID,
      tool_call_id: WRITE_NOTE_CALL_ID,
    },
  ],
  result: {
    output: null,
    required_actions: [EventType.TOOL_APPROVAL_REQUIRED],
    root_agent_error: null,
  },
  context: [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: WRITE_NOTE_CALL_ID,
          function: {
            name: WRITE_NOTE_TOOL_NAME,
            arguments: WRITE_NOTE_ARGUMENTS,
          },
        },
      ],
    },
  ],
};

const EXPECTED_RESUME = {
  sendTypes: [InternalEventType.AGENT_CONTEXT_APPEND],
  executeTrace: [
    {
      type: EventType.TOOL_RESPONSE,
      thread_id: ROOT_ID,
      tool_call_id: WRITE_NOTE_CALL_ID,
    },
    {
      type: EventType.MODEL_MESSAGE,
      thread_id: ROOT_ID,
      content: null,
    },
    {
      type: InternalEventType.AGENT_DONE,
      thread_id: ROOT_ID,
    },
  ],
  result: {
    output: { thread_id: ROOT_ID, content: ROOT_FINAL },
    required_actions: [],
    root_agent_error: null,
  },
  context: [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: WRITE_NOTE_CALL_ID,
          function: {
            name: WRITE_NOTE_TOOL_NAME,
            arguments: WRITE_NOTE_ARGUMENTS,
          },
        },
      ],
    },
    {
      role: 'approval_decision',
      tool_call_id: WRITE_NOTE_CALL_ID,
    },
    {
      role: 'tool',
      tool_call_id: WRITE_NOTE_CALL_ID,
      content: WRITE_NOTE_RESULT,
    },
    {
      role: 'assistant',
      content: ROOT_FINAL,
    },
  ],
};

describe('core E2E: orchestrator pause then resume on tool approval', () => {
  it('pauses for write_note approval, then finishes after allow', async () => {
    const logger = makeDummyLogger();
    const thread = makeApprovalThread();
    const orchestrator = new AgentThreadOrchestrator({
      agentThreads: new Map([[thread.threadId, thread]]),
      createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent in approval test')),
      tracing: NOOP_AGENT_TRACING,
      logger,
    });

    const paused = await runOrchestratorTurn({
      orchestrator,
      rootThread: thread,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      logger,
    });
    expectTurn(paused, EXPECTED_PAUSE);

    const resumed = await runOrchestratorTurn({
      orchestrator,
      rootThread: thread,
      sendBatch: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: ROOT_ID,
          tool_call_id: WRITE_NOTE_CALL_ID,
          approval: { status: 'allow' },
        },
      ],
      logger,
    });
    expectTurn(resumed, EXPECTED_RESUME);
  });
});

function makeApprovalThread(): AgentThread {
  const agentDefinition: AgentDefinition = {
    modelClient: makeApprovalThenTextLLM(ROOT_FINAL),
    instruction: 'You are running in a test setup.',
    messages: undefined,
    modelParams: undefined,
    responseFormat: undefined,
    iterationLimit: undefined,
    toolSets: [makeApprovalGatedWriteNoteToolSet()],
  };

  const agentThreadInput: AgentThreadConstructorInput = {
    definition: agentDefinition,
    threadId: ROOT_ID,
    title: 'e2e-orchestration-approval',
    parent: undefined,
    agentInfo: undefined,
    context: undefined,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox: undefined,
    capabilities: undefined,
    capabilityState: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeDummyLogger(),
  };

  return new AgentThread(agentThreadInput);
}
