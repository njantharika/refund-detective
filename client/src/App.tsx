import { Route, Routes } from 'react-router-dom';
import { Construction } from 'lucide-react';
import { Shell, PageHeader } from './components/Shell';
import { Card, EmptyState } from './components/ui';
import { OverviewPage } from './pages/Overview';
import { TransactionsPage } from './pages/Transactions';
import { SettingsPage } from './pages/Settings';

function NotBuiltYet({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState icon={Construction} title="Not built yet">
          This section is part of an upcoming build phase. Nothing here is simulated.
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
        <Route path="/investigations/*" element={<NotBuiltYet title="Investigations" />} />
        <Route path="/refunds" element={<NotBuiltYet title="Refunds" />} />
        <Route path="/disputes" element={<NotBuiltYet title="Disputes" />} />
        <Route path="/events" element={<NotBuiltYet title="Event Monitor" />} />
        <Route path="/insights" element={<NotBuiltYet title="Insights" />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotBuiltYet title="Not found" />} />
      </Routes>
    </Shell>
  );
}
