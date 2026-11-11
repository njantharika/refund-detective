import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, PlugZap, XCircle } from 'lucide-react';
import { api, type ConnectionTest, type IntegrationStatus } from '../lib/api';
import { dateTime, relative } from '../lib/format';
import { PageHeader } from '../components/Shell';
import { Button, Card, ErrorState, Field, Notice, Pill, Skeleton, StatusBadge } from '../components/ui';

function Countdown({ iso }: { iso: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return <span className="text-rose-300">expired</span>;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return <span className="tabular-nums">{h}h {m}m left</span>;
}

const MCP_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { ready: 'success', starting: 'warning', restarting: 'warning', error: 'danger', stopped: 'neutral' };

export function SettingsPage() {
  const status = useQuery({ queryKey: ['integration-status'], queryFn: () => api<IntegrationStatus>('/api/settings/integration-status'), refetchInterval: 15_000 });
  const test = useMutation({ mutationFn: () => api<ConnectionTest>('/api/settings/test-connection', { method: 'POST', body: '{}' }), onSettled: () => status.refetch() });
  const s = status.data;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Integration health. Secret values are never displayed."
        actions={
          <Button onClick={() => test.mutate()} disabled={test.isPending}>
            <PlugZap className="h-4 w-4" /> {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        }
      />
      {status.error && <ErrorState error={status.error} onRetry={() => status.refetch()} />}
      {!s && status.isLoading && <Skeleton className="h-64 w-full" />}

      {test.data && (
        <Card className="mb-6" title="Connection test" subtitle={`Read-only checks · ${dateTime(test.data.at)}`}>
          <ul className="space-y-3">
            {test.data.checks.map((c) => (
              <li key={c.tool} className="flex items-start gap-3">
                {c.ok ? <CheckCircle2 aria-label="passed" className="mt-0.5 h-4 w-4 text-teal" /> : <XCircle aria-label="failed" className="mt-0.5 h-4 w-4 text-rose-400" />}
                <div className="min-w-0 text-sm">
                  <div>
                    <span className="mono text-slate-200">{c.tool}</span> <span className="text-slate-500">· {c.durationMs} ms{c.path ? ` · via ${c.path === 'mcp' ? 'MCP' : 'REST fallback'}` : ''}</span>
                  </div>
                  {c.message && <div className="text-rose-200/80">{c.message}</div>}
                  {c.hint && <div className="mt-1 text-amber-200">{c.hint}</div>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {test.error && <ErrorState title="Connection test failed" error={test.error} />}

      {s && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="PayPal" subtitle={s.paypal.apiBase}>
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Environment">
                <Pill tone="warning">{s.paypal.environment}</Pill>
              </Field>
              <Field label="Auth mode">{s.paypal.auth.mode.replace('_', ' ')}</Field>
              <Field label="Token">{s.paypal.auth.hasToken ? 'Present (hidden)' : 'Missing'}</Field>
              <Field label="Token expiry">{s.paypal.auth.expiresAt ? <Countdown iso={s.paypal.auth.expiresAt} /> : s.paypal.auth.mode === 'static_token' ? 'Unknown (static token)' : 'Not available'}</Field>
            </dl>
            {s.paypal.auth.warning && (
              <div className="mt-4">
                <Notice title="Credentials">{s.paypal.auth.warning}</Notice>
              </div>
            )}
            {s.paypal.auth.lastError && (
              <div className="mt-4">
                <Notice tone="danger" title="Last auth error">
                  {s.paypal.auth.lastError}
                </Notice>
              </div>
            )}
          </Card>

          <Card title="PayPal MCP server" subtitle={s.paypal.mcp?.command ?? 'Not started'} actions={s.paypal.mcp && <StatusBadge status={s.paypal.mcp.state.toUpperCase()} tone={MCP_TONE[s.paypal.mcp.state]} />}>
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Server">{s.paypal.mcp?.serverName ? `${s.paypal.mcp.serverName} ${s.paypal.mcp.serverVersion ?? ''}` : 'Not available'}</Field>
              <Field label="Tools discovered">{s.paypal.mcp?.toolCount ?? 0}</Field>
              <Field label="Allowlisted in use">{s.paypal.tools.filter((t) => t.allowed).length}</Field>
              <Field label="Restarts">{s.paypal.mcp?.restarts ?? 0}</Field>
              <Field label="Last call">
                {s.paypal.lastCall ? (
                  <span>
                    <span className="mono">{s.paypal.lastCall.tool}</span> {s.paypal.lastCall.ok ? 'ok' : `failed (${s.paypal.lastCall.errorCode})`} · {s.paypal.lastCall.durationMs} ms · {relative(s.paypal.lastCall.at)}
                  </span>
                ) : (
                  'No calls yet'
                )}
              </Field>
              <Field label="Served by">
                MCP {s.paypal.pathUsage.mcp} · REST {s.paypal.pathUsage.rest_fallback}
              </Field>
            </dl>
            {s.paypal.restFallback.active && (
              <div className="mt-4">
                <Notice title="REST fallback active">The MCP server is not connected, so reads are served by the server-side REST fallback.</Notice>
              </div>
            )}
            {s.paypal.mcp?.lastError && (
              <div className="mt-4">
                <Notice tone="danger" title="MCP error">
                  {s.paypal.mcp.lastError}
                </Notice>
              </div>
            )}
            {s.paypal.missingAllowedTools.length > 0 && (
              <div className="mt-4">
                <Notice tone="danger" title="Allowlisted tools missing from the server">
                  {s.paypal.missingAllowedTools.join(', ')}
                </Notice>
              </div>
            )}
            {s.paypal.tools.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {s.paypal.tools
                  .filter((t) => t.allowed)
                  .map((t) => (
                    <span key={t.name} className="mono rounded bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-slate-300 ring-1 ring-white/[0.06]">
                      {t.name}
                    </span>
                  ))}
              </div>
            )}
          </Card>

          <Card title="AI provider" actions={<StatusBadge status={s.ai.configured ? 'CONFIGURED' : 'NOT CONFIGURED'} tone={s.ai.configured ? 'success' : 'warning'} />}>
            <dl className="grid grid-cols-2 gap-4">
              <Field label="Provider">{s.ai.provider}</Field>
              <Field label="Council rebuttal round">{s.ai.councilRebuttal ? 'Enabled' : 'Disabled'}</Field>
              {Object.entries(s.ai.models).map(([role, model]) => (
                <Field key={role} label={role} mono>
                  {model}
                </Field>
              ))}
            </dl>
            {!s.ai.configured && (
              <div className="mt-4">
                <Notice title="AI not configured">
                  Set <code className="mono">ANTHROPIC_API_KEY</code> in <code className="mono">.env</code> and restart the server.
                </Notice>
              </div>
            )}
          </Card>

          <Card title="System">
            <dl className="grid grid-cols-2 gap-4">
              <Field label="App version">{s.appVersion}</Field>
              <Field label="Database" mono>
                {s.database.path}
              </Field>
              <Field label="Database size">{s.database.sizeBytes !== null ? `${(s.database.sizeBytes / 1024).toFixed(0)} KB` : 'Not available'}</Field>
              <Field label="Webhooks">{s.webhooks.configured ? `Configured · ${s.webhooks.received} received` : 'Not configured'}</Field>
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}
