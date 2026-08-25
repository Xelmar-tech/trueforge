import { EventType } from '../../src/core/events/schema';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../agent-session/testHelpers';
import { makeTextLlm } from './helpers';

const THREAD_ID = 'main';
const REPLY = 'hello from the mocked model';

/** Root thread with a one-shot text LLM and no tool sets. */
function makeTextLlmThread(): AgentThread {
  return new AgentThread({
    threadId: THREAD_ID,
    title: 'e2e-orchestration',
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient: makeTextLlm(REPLY),
      instruction: 'You are running in a test setup.',
    },
  });
}

describe('core E2E: orchestrator with mocked LLM and no tools', () => {
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

    // send() commits user input into thread context; it does not call the LLM.
    const sendTypes: string[] = [];
    for await (const event of orchestrator.send([{ type: EventType.USER_MESSAGE, content: 'hello' }])) {
      sendTypes.push(event.type);
    }
    expect(sendTypes).toEqual([InternalEventType.AGENT_CONTEXT_APPEND]);

    // execute() runs the LLM loop. Manual next() is required so we can read the
    // generator's return value (AgentThreadExecutionResult) after the last yield.
    const types: string[] = [];
    const iterator = orchestrator.execute({ signal: new AbortController().signal });
    let step = await iterator.next();
    while (!step.done) {
      types.push(step.value.type);
      step = await iterator.next();
    }

    // Happy path: stream the reply, then a terminal AGENT_DONE. No tools or child threads.
    expect(types).toContain(EventType.MODEL_MESSAGE_DELTA);
    expect(types).toContain(EventType.MODEL_MESSAGE);
    expect(types[types.length - 1]).toBe(InternalEventType.AGENT_DONE);
    expect(types).not.toContain(EventType.TOOL_RESPONSE);
    expect(types).not.toContain(EventType.THREAD_CREATED);

    // Result is the orchestrator return, not an event: final assistant output, no pause/error.
    expect(step.value.required_actions).toEqual([]);
    expect(step.value.root_agent_error).toBeUndefined();
    expect(step.value.output).toMatchObject({
      type: EventType.MODEL_MESSAGE,
      thread_id: THREAD_ID,
      content: REPLY,
    });

    // Durable thread context after send + execute: user turn plus the assistant reply.
    const snapshot = thread.toSnapshot();
    expect(snapshot.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'hello' }),
        expect.objectContaining({ role: 'assistant', content: REPLY }),
      ]),
    );
  });
});
