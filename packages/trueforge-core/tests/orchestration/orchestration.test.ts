import { EventType } from '../../src/core/events/schema';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../core/harnessMocks';
import { llmCreateInputs, makeTextLLM, runTurn } from './helpers/helpers';

const THREAD_ID = 'main';
const REPLY = 'hello from the mocked model';
const INSTRUCTION = 'You are running in a test setup.';

/** One root thread, no tools: user message in, text reply out. */
const EXPECTED_EVENTS = [
  { type: EventType.MODEL_MESSAGE, thread_id: THREAD_ID },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: THREAD_ID, content: REPLY },
  { type: InternalEventType.AGENT_CONTEXT_APPEND, thread_id: THREAD_ID },
  { type: InternalEventType.AGENT_DONE, thread_id: THREAD_ID, status: 'done' },
];

const OUTPUT = {
  output: { thread_id: THREAD_ID, content: REPLY },
  required_actions: [],
};

const EXPECTED_LLM_INPUT = [
  {
    stream: true,
    messages: [
      { role: 'system', content: expect.stringContaining(INSTRUCTION) },
      { role: 'user', content: 'hello' },
    ],
  },
];

/** Root thread with a one-shot text LLM and no tool sets. */
function makeTextLlmThread(): AgentThread {
  return new AgentThread({
    threadId: THREAD_ID,
    title: 'orchestration',
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient: makeTextLLM(REPLY),
      instruction: INSTRUCTION,
    },
  });
}

describe('orchestration: mocked LLM and no tools', () => {
  it('sends a user message and finishes the thread with a text reply', async () => {
    const thread = makeTextLlmThread();
    // Orchestrator owns the thread map and fans send/execute across live threads.
    // This case has only the root thread, so sub-agent creation must never run.
    const orchestrator = new AgentThreadOrchestrator({
      agentThreads: new Map([[thread.threadId, thread]]),
      createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent in no-tool test')),
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });

    const { events, result } = await runTurn({
      orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
    });

    expect(events).toMatchObject(EXPECTED_EVENTS);
    expect(result).toMatchObject(OUTPUT);
    expect(result.root_agent_error).toBeUndefined();
    expect(llmCreateInputs(thread.definition.modelClient)).toMatchObject(EXPECTED_LLM_INPUT);
  });
});
