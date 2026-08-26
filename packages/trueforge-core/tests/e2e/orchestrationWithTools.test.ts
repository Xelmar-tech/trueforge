import type { AgentDefinition, CreateDynamicSubAgentThread } from '../../src/core';
import { DynamicSubAgents } from '../../src/core/capabilities/builtins/DynamicSubAgents';
import { EventType } from '../../src/core/events/schema';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { type AgentThreadConstructorInput } from '../../src/core/runtime/AgentThread.types';
import {
  AgentThreadOrchestrator,
  type AgentThreadOrchestratorInput,
} from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeDummyLogger, makeRootLLM, makeTextLLM } from './helpers';

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
    logger: makeDummyLogger(),
  };

  let agentThread = new AgentThread(agentThreadInput);

  return agentThread;
}

const createSubAgentThread: CreateDynamicSubAgentThread = async ({ parentDefinition, request, threadId, parent }) => {
  const agentDefinition: AgentDefinition = {
    modelClient: makeTextLLM('hello from the child'), // Child has text only LLM,
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
    logger: makeDummyLogger(),
  });
};

describe('core E2E: orchestrator with mocked LLM and no tools', () => {
  it('sends a user message and finishes the thread with a text reply', async () => {
    const logger = makeDummyLogger();
    const thread_1 = makeMainLLMThread('thread_1', 'How are you?', 'e2e-orchestration-with-tools');

    let orchestratorInput: AgentThreadOrchestratorInput = {
      agentThreads: new Map([[thread_1.threadId, thread_1]]),
      createDynamicSubAgentThread: createSubAgentThread,
      tracing: NOOP_AGENT_TRACING,
      logger,
    };

    const orchestrator = new AgentThreadOrchestrator(orchestratorInput);

    const sendTypes: string[] = [];
    for await (const event of orchestrator.send([{ type: EventType.USER_MESSAGE, content: 'hello' }])) {
      sendTypes.push(event.type);
    }
    logger.info('send complete', { sendTypes });

    const types: string[] = [];
    const iterator = orchestrator.execute({ signal: new AbortController().signal });
    let step = await iterator.next();
    while (!step.done) {
      const event = step.value;
      logger.info('execute event', {
        type: event.type,
        thread_id: 'thread_id' in event ? event.thread_id : null,
      });
      types.push(event.type);
      step = await iterator.next();
    }

    logger.info('execute result', {
      types,
      output: step.value.output?.content ?? null,
      required_actions: step.value.required_actions.map(action => action.type),
      root_agent_error: step.value.root_agent_error ?? null,
    });
  });
});
