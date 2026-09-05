'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import { Icon } from '@/icons/Icon.js';
import { useAutomationServer } from '@/server/ServerContext.js';
import type { EventSource, GithubManifestStart } from '@/server/types.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import { useToasterOptional } from '../ToasterContainer.js';

/**
 * Hands the manifest to GitHub the only way GitHub accepts it: a form POST from the
 * browser. GitHub creates the App and redirects back to the server callback.
 */
export function submitGithubManifest(start: GithubManifestStart, doc: Document = document): void {
  const form = doc.createElement('form');
  form.method = 'post';
  form.action = start.actionUrl;
  const input = doc.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = JSON.stringify(start.manifest);
  form.appendChild(input);
  doc.body.appendChild(form);
  form.submit();
}

function statusPresentation(status: EventSource['status']): { label: string; className: string } {
  switch (status) {
    case 'active':
      return { label: 'Connected', className: 'text-success-bg' };
    case 'pending':
      return { label: 'Waiting for GitHub', className: 'text-warning-bg' };
    case 'error':
      return { label: 'Delivery failed', className: 'text-failure-bg' };
  }
}

function formatInstant(iso: string | null): string {
  if (iso == null) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const EventSourceSettings = () => {
  const automationServer = useAutomationServer();
  const toaster = useToasterOptional();
  const [sources, setSources] = useState<EventSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [name, setName] = useState('github');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSources(await automationServer.listEventSources());
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load event sources'));
    } finally {
      setLoading(false);
    }
  }, [automationServer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The manifest callback lands on /settings?section=sources&isSuccess=…; say what happened once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('section') !== 'sources' || !params.has('isSuccess')) return;
    if (params.get('isSuccess') === 'true') {
      toaster?.showSuccess({
        title: 'GitHub App connected',
        description: 'Install it on a repository to start receiving events.',
      });
    } else {
      toaster?.showError(new Error(params.get('reason') ?? 'GitHub did not complete the App creation'));
    }
    params.delete('isSuccess');
    params.delete('reason');
    params.delete('source');
    const search = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
  }, [toaster]);

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const start = await automationServer.startGithubManifest({
        name: name.trim(),
        ...(owner.trim().length > 0 ? { owner: owner.trim() } : {}),
      });
      submitGithubManifest(start);
    } catch (err) {
      setFormError(getErrorMessage(err, 'Failed to start the GitHub App flow'));
      setBusy(false);
    }
  };

  const handleDelete = async (source: EventSource) => {
    try {
      await automationServer.deleteEventSource({ id: source.id });
      toaster?.showSuccess({ title: 'Event source removed' });
      await refresh();
    } catch (err) {
      toaster?.showError(err);
    }
  };

  const external = sources.filter(source => source.kind !== 'trueforge');

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-text-primary text-base font-semibold">Event sources</h2>
          <p className="text-text-secondary mt-1 text-sm">
            A GitHub App delivers webhooks here. Automations trigger on those events; the App is created for you.
          </p>
        </div>
        <Button type="button" onClick={() => setConnectOpen(true)}>
          <Icon name="plus" className="size-3.5" />
          Connect GitHub
        </Button>
      </div>

      {loading ? (
        <p className="text-text-secondary text-sm">Loading…</p>
      ) : error != null ? (
        <p className="text-failure-bg text-sm">{error}</p>
      ) : external.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <p className="text-text-primary text-sm font-medium">No event sources yet</p>
          <p className="text-text-secondary mt-1 text-sm">
            Connect a GitHub App to start recording issue, pull request and check events.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {external.map(source => {
            const status = statusPresentation(source.status);
            return (
              <li key={source.id} className="rounded-lg border border-border bg-card-bg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-text-primary truncate text-sm font-semibold">{source.name}</span>
                      <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
                    </div>
                    <dl className="text-text-secondary mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                      <dt>GitHub App</dt>
                      <dd className="min-w-0 truncate">
                        {source.app == null ? (
                          'not created yet'
                        ) : (
                          <a
                            href={source.app.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary-button-bg hover:underline"
                          >
                            {source.app.owner != null ? `${source.app.owner}/` : ''}
                            {source.app.appSlug}
                          </a>
                        )}
                      </dd>
                      <dt>Webhook</dt>
                      <dd className="min-w-0 truncate font-mono">{source.webhookUrl || 'PUBLIC_BASE_URL not set'}</dd>
                      <dt>Last delivery</dt>
                      <dd>{formatInstant(source.lastDeliveryAt)}</dd>
                    </dl>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${source.name}`}
                    className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
                    onClick={() => void handleDelete(source)}
                  >
                    <Icon name="trash" className="size-4" />
                  </button>
                </div>
                {source.app != null ? (
                  <p className="text-text-secondary mt-3 text-xs">
                    Install the App on the repositories you want events from:{' '}
                    <a
                      href={`${source.app.htmlUrl}/installations/new`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary-button-bg hover:underline"
                    >
                      open installation page
                    </a>
                    .
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <CenteredModal
        open={connectOpen}
        onOpenChange={open => {
          setConnectOpen(open);
          if (!open) setFormError(null);
        }}
        title="Connect GitHub"
        description="A GitHub App is created from a manifest. You approve it once on GitHub and come straight back."
      >
        <form className="flex flex-col gap-4" onSubmit={event => void handleConnect(event)}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Source name</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="github"
              className={auiInputClass('h-9')}
              required
            />
            <span className="text-text-secondary mt-1 block text-xs">
              Also the App name on GitHub; must be unique there.
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Organization (optional)</span>
            <input
              value={owner}
              onChange={e => setOwner(e.target.value)}
              placeholder="my-org"
              className={auiInputClass('h-9')}
            />
            <span className="text-text-secondary mt-1 block text-xs">
              Create the App under this organization; leave empty for your personal account.
            </span>
          </label>
          {formError != null ? <p className="text-failure-bg text-sm">{formError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConnectOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim().length < 2}>
              {busy ? 'Opening GitHub…' : 'Continue on GitHub'}
            </Button>
          </div>
        </form>
      </CenteredModal>
    </div>
  );
};

export default EventSourceSettings;
