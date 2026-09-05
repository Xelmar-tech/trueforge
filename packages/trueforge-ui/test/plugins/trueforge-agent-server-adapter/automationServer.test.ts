import {
  toUiAutomation,
  toUiAutomationRun,
  toUiEvent,
  toUiEventSource,
  toWireManifest,
} from '@/plugins/trueforge-agent-server-adapter/automations/automationServer.js';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describe, expect, it } from 'vitest';

const subject: TrueForgeApi.CreatedBySubject = {
  subjectId: 'alice',
  subjectType: 'user',
  subjectDisplayName: 'alice',
};

const index = {
  idToName: new Map([['agent-1', 'planner']]),
  nameToId: new Map([['planner', 'agent-1']]),
};

describe('automationServer adapter', () => {
  it('flattens an automation manifest into the UI shape and back', () => {
    const wire: TrueForgeApi.Automation = {
      id: 'auto-1',
      name: 'plan-mission',
      agentName: 'planner',
      createdBySubject: subject,
      createdAt: new Date('2026-09-05T10:00:00.000Z'),
      updatedAt: new Date('2026-09-05T10:05:00.000Z'),
      manifest: {
        trigger: {
          type: 'event',
          sourceId: 'src-1',
          kind: 'issues.labeled',
          when: { all: [{ field: 'label.name', op: 'eq', value: 'ready-for-planning' }] },
        },
        coalesceSeconds: 30,
        lane: [
          { type: 'field', path: 'repository.full_name' },
          { type: 'literal', value: 'planning' },
        ],
        task: 'Plan it.',
        emit: ['plan.published'],
        mode: 'shadow',
        status: 'active',
      },
    };
    const ui = toUiAutomation(wire, index);
    expect(ui).toEqual({
      id: 'auto-1',
      name: 'plan-mission',
      agentId: 'agent-1',
      agentName: 'planner',
      trigger: {
        sourceId: 'src-1',
        kind: 'issues.labeled',
        conditions: [{ field: 'label.name', op: 'eq', value: 'ready-for-planning' }],
      },
      coalesceSeconds: 30,
      lane: [
        { type: 'field', path: 'repository.full_name' },
        { type: 'literal', value: 'planning' },
      ],
      task: 'Plan it.',
      emit: ['plan.published'],
      mode: 'shadow',
      status: 'active',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:05:00.000Z',
    });
    expect(toWireManifest(ui)).toEqual(wire.manifest);
  });

  it('applies manifest defaults when the wire omits them', () => {
    const ui = toUiAutomation(
      {
        id: 'auto-2',
        name: 'bare',
        agentName: 'unknown-agent',
        createdBySubject: subject,
        createdAt: new Date('2026-09-05T10:00:00.000Z'),
        updatedAt: new Date('2026-09-05T10:00:00.000Z'),
        manifest: { trigger: { type: 'event', sourceId: 'src-1', kind: 'push' }, task: 'Go' },
      },
      index,
    );
    expect(ui.agentId).toBe('unknown-agent');
    expect(ui.trigger.conditions).toEqual([]);
    expect(ui.coalesceSeconds).toBe(30);
    expect(ui.lane).toEqual([]);
    expect(ui.emit).toEqual([]);
    expect(ui.mode).toBe('shadow');
    expect(ui.status).toBe('active');
  });

  it('maps runs, events and sources with ISO instants', () => {
    const run = toUiAutomationRun({
      id: 'run-1',
      automationId: 'auto-1',
      subjectKey: 'o/r#61',
      laneKey: 'o/r/planning',
      status: 'shadowed',
      mode: 'shadow',
      eventIds: ['ev-1'],
      sessionId: 'ses-1',
      scheduledFor: new Date('2026-09-05T10:00:30.000Z'),
      triggeredAt: new Date('2026-09-05T10:00:35.000Z'),
      finishedAt: null,
      outcome: { required_actions: [] },
      createdBySubject: subject,
      createdAt: new Date('2026-09-05T10:00:00.000Z'),
      updatedAt: new Date('2026-09-05T10:00:35.000Z'),
    });
    expect(run.scheduledFor).toBe('2026-09-05T10:00:30.000Z');
    expect(run.triggeredAt).toBe('2026-09-05T10:00:35.000Z');
    expect(run.finishedAt).toBeNull();

    const event = toUiEvent({
      id: 'ev-1',
      sourceId: 'src-1',
      sourceKind: 'github',
      kind: 'issues.labeled',
      subjectKey: 'o/r#61',
      deliveryId: 'd-1',
      summary: { repository: 'o/r', number: 61, title: 'Mission', actor: 'aaron', label: 'ready-for-planning' },
      receivedAt: new Date('2026-09-05T10:00:00.000Z'),
      routedAt: null,
    });
    expect(event.receivedAt).toBe('2026-09-05T10:00:00.000Z');
    expect(event.summary.number).toBe(61);

    const pending = toUiEventSource({
      id: 'src-1',
      kind: 'github',
      name: 'github',
      status: 'pending',
      manifest: { kind: 'github', app: null },
      webhookUrl: 'https://forge.example/api/v1/webhooks/src-1',
      lastDeliveryAt: null,
      createdBySubject: subject,
      createdAt: new Date('2026-09-05T10:00:00.000Z'),
      updatedAt: new Date('2026-09-05T10:00:00.000Z'),
    });
    expect(pending.app).toBeNull();

    const active = toUiEventSource({
      id: 'src-1',
      kind: 'github',
      name: 'github',
      status: 'active',
      manifest: {
        kind: 'github',
        app: {
          appId: 42,
          appSlug: 'tf-dogfood',
          clientId: 'c',
          htmlUrl: 'https://github.com/apps/tf-dogfood',
          owner: 'Xelmar',
        },
      },
      webhookUrl: 'https://forge.example/api/v1/webhooks/src-1',
      lastDeliveryAt: new Date('2026-09-05T10:00:00.000Z'),
      createdBySubject: subject,
      createdAt: new Date('2026-09-05T10:00:00.000Z'),
      updatedAt: new Date('2026-09-05T10:00:00.000Z'),
    });
    expect(active.app).toEqual({
      appId: 42,
      appSlug: 'tf-dogfood',
      htmlUrl: 'https://github.com/apps/tf-dogfood',
      owner: 'Xelmar',
    });
    expect(active.lastDeliveryAt).toBe('2026-09-05T10:00:00.000Z');
  });
});
