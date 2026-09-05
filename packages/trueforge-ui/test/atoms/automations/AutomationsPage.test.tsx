// @vitest-environment jsdom
import { AutomationsPage } from '@/atoms/automations/AutomationsPage.js';
import { ToasterProvider } from '@/containers/ToasterContainer.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { Automation, AutomationRun, AutomationServer } from '@/server/types.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAgentUIServer } from '../../server/mockServer.js';

const sampleAutomation: Automation = {
  id: 'auto-1',
  name: 'plan-mission',
  agentId: 'planner',
  agentName: 'planner',
  trigger: {
    sourceId: 'src-1',
    kind: 'issues.labeled',
    conditions: [{ field: 'label.name', op: 'eq', value: 'ready-for-planning' }],
  },
  coalesceSeconds: 30,
  lane: [{ type: 'literal', value: 'planning' }],
  task: 'Plan it.',
  emit: ['plan.published'],
  mode: 'shadow',
  status: 'active',
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
};

const sampleRuns: AutomationRun[] = [
  {
    id: 'run-1',
    automationId: 'auto-1',
    subjectKey: 'o/r#61',
    laneKey: 'planning',
    status: 'shadowed',
    mode: 'shadow',
    eventIds: ['ev-1'],
    sessionId: 'ses-1',
    scheduledFor: '2026-09-05T10:00:30.000Z',
    triggeredAt: '2026-09-05T10:00:35.000Z',
    finishedAt: '2026-09-05T10:05:00.000Z',
    outcome: { required_actions: [{ type: 'tool.approval_required', toolName: 'publish_draft_tickets' }] },
  },
  {
    id: 'run-2',
    automationId: 'auto-1',
    subjectKey: 'o/r#62',
    laneKey: 'planning',
    status: 'coalescing',
    mode: 'shadow',
    eventIds: ['ev-2', 'ev-3'],
    sessionId: null,
    scheduledFor: '2026-09-05T10:10:00.000Z',
    triggeredAt: null,
    finishedAt: null,
    outcome: null,
  },
];

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeEach(() => {
  window.history.replaceState(null, '', '/automations');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function showModal(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  if (originalShowModal === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  }
  if (originalClose === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
  }
});

function mockAutomationServer(automations: Automation[], overrides: Partial<AutomationServer> = {}): AutomationServer {
  return {
    listAutomations: vi.fn(async () => ({ data: automations })),
    getAutomation: vi.fn(),
    createAutomation: vi.fn(),
    updateAutomation: vi.fn(),
    deleteAutomation: vi.fn(async () => undefined),
    listAutomationRuns: vi.fn(async () => sampleRuns),
    replayAutomation: vi.fn(),
    listEvents: vi.fn(async () => ({ data: [] })),
    getEvent: vi.fn(),
    listEventSources: vi.fn(async () => []),
    startGithubManifest: vi.fn(),
    deleteEventSource: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPage(automations: Automation[] = [sampleAutomation], overrides: Partial<AutomationServer> = {}) {
  const automationServer = mockAutomationServer(automations, overrides);
  const server = { ...createMockAgentUIServer(), automations: automationServer };
  render(
    <ServerProvider server={server}>
      <ToasterProvider>
        <AutomationsPage />
      </ToasterProvider>
    </ServerProvider>,
  );
  return { automationServer };
}

describe('AutomationsPage', () => {
  it('lists automations with trigger, mode and run chips', async () => {
    renderPage();
    expect(await screen.findByText('plan-mission')).toBeTruthy();
    expect(screen.getByText(/issues\.labeled · label\.name is ready-for-planning/)).toBeTruthy();
    // The mode badge; the mode filter also lists "Shadow" as an option.
    expect(screen.getAllByText('Shadow').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByLabelText(/Shadowed run at/)).toBeTruthy();
    });
    expect(screen.getByText('1 window open')).toBeTruthy();
    expect(screen.getByText(/emits plan\.published/)).toBeTruthy();
  });

  it('shows the empty state and opens the create drawer', async () => {
    renderPage([]);
    expect(await screen.findByText('No Automations Yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New Automation/ }));
    expect(await screen.findByText('Wake an agent when something happens.')).toBeTruthy();
    expect(screen.getByPlaceholderText('plan-mission')).toBeTruthy();
    expect(screen.getByPlaceholderText('issues.labeled')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeTruthy();
  });

  it('pauses an automation through update and reloads', async () => {
    const updateAutomation = vi.fn(async () => ({ ...sampleAutomation, status: 'paused' as const }));
    const { automationServer } = renderPage([sampleAutomation], { updateAutomation });
    await screen.findByText('plan-mission');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for plan-mission' }));
    fireEvent.click(await screen.findByText('Pause'));
    await waitFor(() => {
      expect(updateAutomation).toHaveBeenCalledWith(expect.objectContaining({ id: 'auto-1', status: 'paused' }));
    });
    await waitFor(() => {
      expect(automationServer.listAutomations).toHaveBeenCalledTimes(2);
    });
  });
});
