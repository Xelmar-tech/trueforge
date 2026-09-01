import { EventType } from '../../src/core/events/schema';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeDummyLogger, makeTextLLM } from './helpers/helpers';
import { expectTurn, runOrchestratorTurn } from './helpers/turnExpectations';

const THREAD_ID = 'main';
const REPLY = 'hello from the mocked model';

const EXPECTED = {
  sendTypes: [InternalEventType.AGENT_CONTEXT_APPEND],
  executeTrace: [
    // model.message is an empty stream shell; text lands in deltas / context / result.
    {
      type: EventType.MODEL_MESSAGE,
      thread_id: THREAD_ID,
      content: null,
    },
    {
      type: InternalEventType.AGENT_DONE,
      thread_id: THREAD_ID,
    },
  ],
  result: {
    output: { thread_id: THREAD_ID, content: REPLY },
    required_actions: [],
    root_agent_error: null,
  },
  context: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: REPLY },
  ],
};

/** Root thread with a one-shot text LLM and no tool sets. */
function makeTextLlmThread(): AgentThread {
  return new AgentThread({
    threadId: THREAD_ID,
    title: 'e2e-orchestration',
    tracing: NOOP_AGENT_TRACING,
    logger: makeDummyLogger(),
    definition: {
      modelClient: makeTextLLM(REPLY),
      instruction: 'You are running in a test setup.',
    },
  });
}

describe('core E2E: orchestrator with mocked LLM and no tools', () => {
  it('sends a user message and finishes the thread with a text reply', async () => {
    const logger = makeDummyLogger();
    const thread = makeTextLlmThread();
    // Orchestrator owns the thread map and fans send/execute across live threads.
    // This case has only the root thread, so sub-agent creation must never run.
    const orchestrator = new AgentThreadOrchestrator({
      agentThreads: new Map([[thread.threadId, thread]]),
      createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent in no-tool test')),
      tracing: NOOP_AGENT_TRACING,
      logger,
    });

    const actual = await runOrchestratorTurn({
      orchestrator,
      rootThread: thread,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      logger,
    });

    expectTurn(actual, EXPECTED);
  });
});
