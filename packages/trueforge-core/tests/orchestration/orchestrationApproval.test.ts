import { EventType } from '../../src/core/events/schema';
import { AgentThread } from '../../src/core/runtime/AgentThread';
import { InternalEventType, type AgentThreadConstructorInput } from '../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../src/core/runtime/AgentThreadOrchestrator';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../core/harnessMocks';
import {
  llmCreateInputs,
  makeApprovalGatedWriteNoteToolSet,
  runTurn,
  textReplyStream,
  WRITE_NOTE_ARGUMENTS,
  WRITE_NOTE_CALL_ID,
  WRITE_NOTE_RESULT,
  WRITE_NOTE_TOOL_NAME,
  writeNoteToolCallStream,
} from './helpers/helpers';

const ROOT_ID = 'thread_root';
const ROOT_FINAL = 'note saved';
const INSTRUCTION = 'You are running in a test setup.';

const WRITE_NOTE_TOOLS = [
  { function: { name: 'call_tool' } },
  { function: { name: 'get_tool_info' } },
  { function: { name: 'get_tool_output_schema' } },
  { function: { name: 'list_tools' } },
  { function: { name: WRITE_NOTE_TOOL_NAME } },
];

/** Pause on write_note approval, then resume after allow and finish. */
const EXPECTED_TURN_1_EVENTS = [
  { type: EventType.MODEL_MESSAGE, thread_id: ROOT_ID },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID },
  {
    type: InternalEventType.AGENT_CONTEXT_APPEND,
    thread_id: ROOT_ID,
    context: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: WRITE_NOTE_CALL_ID,
            type: 'function',
            function: { name: WRITE_NOTE_TOOL_NAME, arguments: WRITE_NOTE_ARGUMENTS },
          },
        ],
      },
    ],
  },
  {
    type: EventType.TOOL_APPROVAL_REQUIRED,
    thread_id: ROOT_ID,
    tool_calls: [{ id: WRITE_NOTE_CALL_ID }],
  },
];

const TURN_1_OUTPUT = {
  output: null,
  required_actions: [
    {
      type: EventType.TOOL_APPROVAL_REQUIRED,
      thread_id: ROOT_ID,
      tool_calls: [{ id: WRITE_NOTE_CALL_ID }],
    },
  ],
};

const EXPECTED_TURN_1_INPUT = [
  {
    tools: WRITE_NOTE_TOOLS,
    messages: [
      { role: 'system', content: expect.stringContaining(INSTRUCTION) },
      { role: 'user', content: 'hello' },
    ],
  },
];

const EXPECTED_TURN_2_EVENTS = [
  { type: EventType.TOOL_RESPONSE, thread_id: ROOT_ID, tool_call_id: WRITE_NOTE_CALL_ID },
  {
    type: InternalEventType.AGENT_CONTEXT_APPEND,
    thread_id: ROOT_ID,
    context: [{ role: 'tool', tool_call_id: WRITE_NOTE_CALL_ID, content: WRITE_NOTE_RESULT }],
  },
  { type: EventType.MODEL_MESSAGE, thread_id: ROOT_ID },
  { type: EventType.MODEL_MESSAGE_DELTA, thread_id: ROOT_ID, content: ROOT_FINAL },
  {
    type: InternalEventType.AGENT_CONTEXT_APPEND,
    thread_id: ROOT_ID,
    context: [{ role: 'assistant', content: ROOT_FINAL }],
  },
  { type: InternalEventType.AGENT_DONE, thread_id: ROOT_ID, status: 'done' },
];

const TURN_2_OUTPUT = {
  output: { thread_id: ROOT_ID, content: ROOT_FINAL },
  required_actions: [],
};

const EXPECTED_TURN_2_OUTPUT = {
  tools: WRITE_NOTE_TOOLS,
  messages: [
    { role: 'system', content: expect.stringContaining(INSTRUCTION) },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: WRITE_NOTE_CALL_ID,
          type: 'function',
          function: { name: WRITE_NOTE_TOOL_NAME, arguments: WRITE_NOTE_ARGUMENTS },
        },
      ],
    },
    { role: 'tool', tool_call_id: WRITE_NOTE_CALL_ID, content: WRITE_NOTE_RESULT },
  ],
};

describe('orchestration: pause then resume on tool approval', () => {
  it('pauses for write_note approval, then finishes after allow', async () => {
    const agentThreadInput: AgentThreadConstructorInput = {
      definition: {
        modelClient: {
          create: jest
            .fn()
            .mockImplementationOnce(() => writeNoteToolCallStream())
            .mockImplementation(() => textReplyStream(ROOT_FINAL)),
          createNonStream: jest.fn(),
        },
        instruction: INSTRUCTION,
        messages: undefined,
        modelParams: undefined,
        responseFormat: undefined,
        iterationLimit: undefined,
        toolSets: [makeApprovalGatedWriteNoteToolSet()],
      },
      threadId: ROOT_ID,
      title: 'orchestration-approval',
      parent: undefined,
      agentInfo: undefined,
      context: undefined,
      currentContextUsage: undefined,
      preComputedCompletion: undefined,
      sandbox: undefined,
      capabilities: undefined,
      capabilityState: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    };

    const thread = new AgentThread(agentThreadInput);

    const orchestrator = new AgentThreadOrchestrator({
      agentThreads: new Map([[thread.threadId, thread]]),
      createDynamicSubAgentThread: () => Promise.reject(new Error('unexpected sub-agent in approval test')),
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });

    const paused = await runTurn({
      orchestrator,
      sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
    });

    // Asserts
    expect(paused.events).toMatchObject(EXPECTED_TURN_1_EVENTS);
    expect(paused.result).toMatchObject(TURN_1_OUTPUT);
    expect(paused.result.root_agent_error).toBeUndefined();
    expect(llmCreateInputs(thread.definition.modelClient)).toMatchObject(EXPECTED_TURN_1_INPUT);

    const resumed = await runTurn({
      orchestrator,
      sendBatch: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: ROOT_ID,
          tool_call_id: WRITE_NOTE_CALL_ID,
          approval: { status: 'allow' },
        },
      ],
    });
    expect(resumed.events).toMatchObject(EXPECTED_TURN_2_EVENTS);
    expect(resumed.result).toMatchObject(TURN_2_OUTPUT);
    expect(resumed.result.root_agent_error).toBeUndefined();
    expect(llmCreateInputs(thread.definition.modelClient)).toMatchObject([
      ...EXPECTED_TURN_1_INPUT,
      EXPECTED_TURN_2_OUTPUT,
    ]);
  });
});
