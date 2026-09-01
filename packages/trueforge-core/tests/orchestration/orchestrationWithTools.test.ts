import type { AgentDefinition, CreateDynamicSubAgentThread } from '../../src/core';
import { DynamicSubAgents } from '../../src/core/capabilities/builtins/DynamicSubAgents';
import { EventType } from '../../src/core/events/schema';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType, type AgentThreadConstructorInput } from '../../src/core/runtime/AgentThread.types';
import {
  AgentThreadOrchestrator,
  type AgentThreadOrchestratorInput,
} from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../core/harnessMocks';
import { makeRootLLM, makeTextLLM, runTurn } from './helpers/helpers';

const ROOT_ID = 'thread_root';
const TOOL_CALL_ID = 'call-sub';
const CHILD_REPLY = 'hello from the child';
const ROOT_FINAL = 'How are you?';

const EXPECTED_EVENTS = [
  { type: EventType.MODEL_MESSAGE, thread_id: ROOT_ID },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID },
  { type: InternalEventType.AGENT_CONTEXT_APPEND, thread_id: ROOT_ID },
  { type: InternalEventType.AGENT_CONTEXT_APPEND, thread_id: ROOT_ID },
  {
    type: EventType.THREAD_CREATED,
    title: 'worker',
    parent: { thread_id: ROOT_ID, tool_call_id: TOOL_CALL_ID },
  },
  { type: EventType.MODEL_MESSAGE, thread_id: expect.any(String) },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: expect.any(String), content: CHILD_REPLY },
  { type: InternalEventType.AGENT_CONTEXT_APPEND, thread_id: expect.any(String) },
  { type: EventType.TOOL_RESPONSE, thread_id: ROOT_ID, tool_call_id: TOOL_CALL_ID },
  { type: InternalEventType.AGENT_CONTEXT_APPEND, thread_id: ROOT_ID },
  { type: InternalEventType.AGENT_DONE, thread_id: expect.any(String), status: 'done' },
  { type: EventType.MODEL_MESSAGE, thread_id: ROOT_ID },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID, content: ROOT_FINAL },
  { type: InternalEventType.AGENT_CONTEXT_APPEND, thread_id: ROOT_ID },
  { type: InternalEventType.AGENT_DONE, thread_id: ROOT_ID, status: 'done' },
];

const OUTPUT = {
  output: { thread_id: ROOT_ID, content: ROOT_FINAL },
  required_actions: [],
};

describe('orchestration: dynamic sub-agent', () => {
  it('delegates via create_sub_agent, routes child result to parent, then finishes', async () => {
    const thread_1 = makeMainLLMThread(ROOT_ID, ROOT_FINAL, 'orchestration-with-tools');

    let orchestratorInput: AgentThreadOrchestratorInput = {
      agentThreads: new Map([[thread_1.threadId, thread_1]]),
      createDynamicSubAgentThread: createSubAgentThread,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    };

    const orchestrator = new AgentThreadOrchestrator(orchestratorInput);

    const { events, result } = await runTurn({
      orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
    });

    expect(events).toMatchObject(EXPECTED_EVENTS);
    expect(result).toMatchObject(OUTPUT);
    expect(result.root_agent_error).toBeUndefined();
  });
});

function makeMainLLMThread(threadId: string, reply: string, title: string): AgentThread {
  let agentDefinition: AgentDefinition = {
    // This is an instance if ILLM
    modelClient: makeRootLLM(reply),
    instruction: 'You are running in a test setup.',
    // Undefined
    messages: undefined,
    modelParams: undefined,
    responseFormat: undefined,
    iterationLimit: undefined,
    toolSets: [new DynamicSubAgents({ tracing: NOOP_AGENT_TRACING })],
  };

  let agentThreadInput: AgentThreadConstructorInput = {
    definition: agentDefinition,
    threadId: threadId,
    title: title,
    // Undefined
    parent: undefined,
    agentInfo: undefined,
    context: undefined,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox: undefined,
    capabilities: undefined,
    capabilityState: undefined,
    // Default
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  };

  let agentThread = new AgentThread(agentThreadInput);

  return agentThread;
}

const createSubAgentThread: CreateDynamicSubAgentThread = async ({ parentDefinition, request, threadId, parent }) => {
  const agentDefinition: AgentDefinition = {
    modelClient: makeTextLLM(CHILD_REPLY), // Child has text only LLM,
    // Not sure if this should be taken from the parent, or left alone
    instruction: undefined,
    messages: [{ role: 'user', content: request.input }],
    modelParams: parentDefinition.modelParams,
    responseFormat: undefined,
    iterationLimit: parentDefinition.iterationLimit,
    toolSets: undefined, // No parents tools sent to the child
  };
  return new AgentThread({
    definition: agentDefinition,
    threadId,
    title: request.name,
    parent,
    agentInfo: request,
    context: undefined,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox: undefined,
    capabilities: undefined,
    capabilityState: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
};
