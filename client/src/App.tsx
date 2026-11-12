import { Route, Routes } from 'react-router-dom';
import { Construction } from 'lucide-react';
import { Shell, PageHeader } from './components/Shell';
import { Card, EmptyState } from './components/ui';
import { OverviewPage } from './pages/Overview';
import { TransactionsPage } from './pages/Transactions';
import { SettingsPage } from './pages/Settings';
import { InvestigationsPage, NewInvestigationPage } from './pages/Investigations';
import { InvestigationWorkspace } from './pages/InvestigationWorkspace';
import { DisputesPage } from './pages/Disputes';
import { InsightsPage } from './pages/Insights';
import { RefundsPage } from './pages/Refunds';
import { RefundDetailPage } from './pages/RefundDetail';

function NotBuiltYet({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState icon={Construction} title="Page not found">
          This page does not exist.
        </EmptyState>
      </Card>
    </>
  );
}

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/investigations" element={<InvestigationsPage />} />
        <Route path="/investigations/new" element={<NewInvestigationPage />} />
        <Route path="/investigations/:id" element={<InvestigationWorkspace />} />
        <Route path="/refunds" element={<RefundsPage />} />
        <Route path="/refunds/:id" element={<RefundDetailPage />} />
        <Route path="/disputes" element={<DisputesPage />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotBuiltYet title="Not found" />} />
      </Routes>
    </Shell>
  );
}
