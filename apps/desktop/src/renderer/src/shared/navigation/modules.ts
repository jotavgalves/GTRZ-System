import {
  ArchiveRestore,
  Boxes,
  ClipboardList,
  CreditCard,
  Cloud,
  LayoutDashboard,
  ReceiptText,
  Settings,
  ShieldCheck,
  Store,
  TableProperties,
  Ticket,
  type LucideIcon,
} from 'lucide-react';

import type { UserProfile } from '@gtrz/contracts';

interface NavigationModule {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon;
  readonly profiles: readonly UserProfile[];
}

export const navigationModules: readonly NavigationModule[] = [
  {
    key: 'dashboard',
    label: 'Visão geral',
    path: '/',
    icon: LayoutDashboard,
    profiles: ['production'],
  },
  {
    key: 'events',
    label: 'Eventos',
    path: '/eventos',
    icon: ClipboardList,
    profiles: ['production'],
  },
  {
    key: 'inventory',
    label: 'Estoque',
    path: '/estoque',
    icon: Boxes,
    profiles: ['production', 'cashier'],
  },
  {
    key: 'tables',
    label: 'Mesas e balcão',
    path: '/mesas',
    icon: TableProperties,
    profiles: ['production', 'cashier'],
  },
  {
    key: 'vouchers',
    label: 'Vouchers',
    path: '/vouchers',
    icon: Ticket,
    profiles: ['production'],
  },
  {
    key: 'cash',
    label: 'Caixa administrativo',
    path: '/caixa',
    icon: CreditCard,
    profiles: ['production'],
  },
  {
    key: 'expenses',
    label: 'Despesas',
    path: '/despesas',
    icon: ReceiptText,
    profiles: ['production'],
  },
  {
    key: 'tickets',
    label: 'Ingressos',
    path: '/ingressos',
    icon: Store,
    profiles: ['production'],
  },
  {
    key: 'audit',
    label: 'Auditoria',
    path: '/auditoria',
    icon: ShieldCheck,
    profiles: ['production'],
  },
  {
    key: 'backups',
    label: 'Backups',
    path: '/backups',
    icon: ArchiveRestore,
    profiles: ['production'],
  },
  {
    key: 'cloud',
    label: 'Nuvem',
    path: '/nuvem',
    icon: Cloud,
    profiles: ['production'],
  },
  {
    key: 'settings',
    label: 'Configurações',
    path: '/configuracoes',
    icon: Settings,
    profiles: ['production'],
  },
];
