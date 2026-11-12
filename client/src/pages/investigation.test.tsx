import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { InvestigationWorkspace } from './InvestigationWorkspace';
import { reportMarkdown } from '../lib/report-md';
import type { Investigation } from '../lib/api';
import { investigation } from '../test/fixtures';
import { mockFetch, renderWithProviders } from '../test/utils';

const renderAt = (inv: Investigation, extra: Record<string, { status?: number; body: unknown }> = {}) => {
  mockFetch({ [`/api/investigations/${inv.id}`]: { body: inv }, [`/api/investigations/${inv.id}/council`]: { body: { items: [] } }, [`/api/investigations/${inv.id}/refunds`]: { body: { items: [] } }, ...extra });
  return renderWithProviders(<Routes><Route path="/investigations/:id" element={<InvestigationWorkspace />} /></Routes>, { route: `/investigations/${inv.id}` });
};

describe('Investigation workspace', () => {
  it('renders cited findings, FactSheet, root cause estimate and the removed-claim notice', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderAt(investigation());
    expect(await screen.findByText('Successful Payment Capture')).toBeInTheDocument();
    expect(screen.getAllByText('42.00 USD').length).toBeGreaterThan(0);
    expect(screen.getByText('estimate')).toBeInTheDocument();
    expect(screen.getByText('1 uncited claim(s) removed by code')).toBeInTheDocument();
    expect(screen.getByText('Invented chargeback')).toHaveClass('line-through');
    // A finding backed only by unverified merchant input is labelled as an allegation.
    const claim = screen.getByText('Customer Missing Email Claim').closest('li')!;
    expect(within(claim).getByText('allegation only')).toBeInTheDocument();
    // Missing evidence appears as a timeline marker on the Evidence tab.
    await userEvent.click(screen.getByRole('tab', { name: /Evidence/ }));
    expect(screen.getByText(/webhooks not configured/)).toBeInTheDocument();
  });

  it('clicking an evidence chip scrolls to and highlights that evidence', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderAt(investigation());
    const finding = (await screen.findByText('Successful Payment Capture')).closest('li')!;
    await userEvent.click(within(finding).getByRole('button', { name: 'Show evidence EV-002' }));
    expect(scroll).toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /Evidence/ })).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('ev-EV-002')).toHaveClass('ring-1');
    // A back link returns to where the citation was clicked.
    await userEvent.click(screen.getByRole('button', { name: /Back to Report/ }));
    expect(await screen.findByText('Successful Payment Capture')).toBeInTheDocument();
  });

  it('keeps the refund CTA disabled until a council approves, and labels the proposal as a recommendation', async () => {
    renderAt(investigation());
    expect(await screen.findByRole('button', { name: /Review & approve refund/ })).toBeDisabled();
    expect(screen.getByText(/recommendation only/)).toBeInTheDocument();
  });

  it('shows the live pipeline stage while running', async () => {
    renderAt(investigation({ stage: 'analyzing', stageDetail: 'Waiting 7s for the AI rate limit…', report: null, running: true }));
    expect(await screen.findByRole('status')).toHaveTextContent('Waiting 7s for the AI rate limit…');
  });

  it('shows a failure state with the real error', async () => {
    renderAt(investigation({ stage: 'failed', error: 'AI_INVALID_OUTPUT: bad JSON', report: null }));
    expect(await screen.findByText('Investigation failed')).toBeInTheDocument();
    expect(screen.getByText(/AI_INVALID_OUTPUT/)).toBeInTheDocument();
  });

  it('says AI not configured instead of showing a fake report', async () => {
    renderAt(investigation({ stage: 'ai_unavailable', report: null, model: null }));
    expect(await screen.findAllByText('AI not configured')).not.toHaveLength(0);
    expect(screen.queryByText('Successful Payment Capture')).not.toBeInTheDocument();
  });
});

describe('Markdown export', () => {
  it('includes FactSheet, cited findings, the estimate label and the Sandbox environment', () => {
    const md = reportMarkdown(investigation());
    expect(md).toContain('PayPal **Sandbox**');
    expect(md).toContain('| Remaining refundable | 42.00 |');
    expect(md).toContain('**Successful Payment Capture** (observed, low) [EV-001, EV-002]');
    expect(md).toContain('Confidence (estimate, not a statistical guarantee): 80%');
    expect(md).toContain('recommendation only; not executed');
  });
});
