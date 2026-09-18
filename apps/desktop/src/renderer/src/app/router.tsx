import { createHashRouter, Navigate } from 'react-router';

import { AuditPage } from '../features/audit';
import { BackupsPage } from '../features/backups';
import { CashPage } from '../features/cash';
import { FoodPage } from '../features/food';
import { CloudMonitorPage } from '../features/cloud-monitor';
import { DashboardPage } from '../features/dashboard';
import { EventsPage } from '../features/events';
import { ExpensesPage } from '../features/expenses';
import { InventoryPage } from '../features/inventory';
import { SettingsPage } from '../features/settings';
import { TablesPage } from '../features/tables';
import { TicketsPage } from '../features/tickets';
import { VouchersPage } from '../features/vouchers';
import { RequireProduction } from '../shared/session/RequireProduction';
import { ErrorPage } from './ErrorPage';
import { AppShell } from './layouts/AppShell';

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <ErrorPage />,
    children: [
      {
        element: <RequireProduction />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'eventos', element: <EventsPage /> },
          { path: 'vouchers', element: <VouchersPage /> },
          { path: 'caixa', element: <CashPage /> },
          { path: 'despesas', element: <ExpensesPage /> },
          { path: 'comida', element: <FoodPage /> },
          { path: 'ingressos', element: <TicketsPage /> },
          { path: 'auditoria', element: <AuditPage /> },
          { path: 'backups', element: <BackupsPage /> },
          { path: 'configuracoes', element: <SettingsPage /> },
          { path: 'nuvem', element: <CloudMonitorPage /> },
        ],
      },
      { path: 'estoque', element: <InventoryPage /> },
      { path: 'mesas', element: <TablesPage /> },
      { path: '*', element: <Navigate replace to="/" /> },
    ],
  },
]);
