import { Cloud, Database, Shield, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { NavLink, Outlet } from 'react-router';

import type { CloudSyncStatus, SystemInfo } from '@gtrz/contracts';

import gtrzLockup from '../../assets/brand/gtrz-lockup.svg';
import { navigationModules } from '../../shared/navigation/modules';
import { preloadViewState } from '../../shared/navigation/view-state-cache';
import { ProfileSwitcher } from '../../shared/session/ProfileSwitcher';
import { useSession } from '../../shared/session/session-context';

function navigationClassName({ isActive }: { readonly isActive: boolean }): string {
  return isActive ? 'sidebar-link sidebar-link--active' : 'sidebar-link';
}

function formatEventDate(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(timestamp);
}

export function AppShell(): React.JSX.Element {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudSyncStatus | null>(null);
  const { state: sessionState, loading: sessionLoading, error: sessionError } = useSession();
  const activeProfile = sessionState?.profile ?? 'production';
  const activeEvent = sessionState?.activeEvent ?? null;

  useEffect(() => {
    let mounted = true;

    void window.gtrz.system
      .getInfo()
      .then((info) => {
        if (mounted) {
          setSystemInfo(info);
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          const message = error instanceof Error ? error.message : 'Falha ao consultar o sistema.';
          setSystemError(message);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    // The three operational views are the routes operators alternate between most often.
    // Warm their local SQLite snapshots before a sidebar click so no empty intermediate view is painted.
    void Promise.allSettled([
      preloadViewState('dashboard', () => window.gtrz.dashboard.getState()),
      preloadViewState('inventory', () => window.gtrz.inventory.getState()),
      preloadViewState('operations', () => window.gtrz.operations.getState()),
    ]);
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadCloudStatus = (): void => {
      void window.gtrz.settings
        .getCloudSyncStatus()
        .then((status) => {
          if (mounted) setCloudStatus(status);
        })
        .catch(() => {
          if (mounted) setCloudStatus(null);
        });
    };

    loadCloudStatus();
    // This is a local IPC read. It refreshes the visible connection state without polling Cloudflare.
    const interval = window.setInterval(loadCloudStatus, 15_000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const visibleModules = useMemo(
    () => navigationModules.filter((module) => module.profiles.includes(activeProfile)),
    [activeProfile],
  );
  const navigationStyle = { '--sidebar-item-count': visibleModules.length } as CSSProperties;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup" aria-label="GTRZ System">
          <img alt="GTRZ" className="brand-lockup__logo" src={gtrzLockup} />
          <span className="brand-lockup__product">System</span>
        </div>

        <div className="event-context">
          <span>Evento ativo</span>
          <strong>{activeEvent?.name ?? 'Nenhum evento selecionado'}</strong>
          <small>
            {activeEvent === null
              ? activeProfile === 'production'
                ? 'Selecione um evento no módulo Eventos.'
                : 'A Produção precisa selecionar um evento.'
              : `Operação de ${formatEventDate(activeEvent.startsAt)}`}
          </small>
        </div>

        <nav className="sidebar-nav" aria-label="Módulos do sistema" style={navigationStyle}>
          {visibleModules.map((module) => {
            const Icon = module.icon;
            return (
              <NavLink
                className={navigationClassName}
                end={module.path === '/'}
                key={module.key}
                to={module.path}
              >
                <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                <span>{module.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="profile-card">
            <span className="profile-card__icon" aria-hidden="true">
              <Shield size={18} />
            </span>
            <div>
              <span>Perfil atual</span>
              <strong>{activeProfile === 'production' ? 'Produção' : 'Caixa'}</strong>
            </div>
          </div>
          <ProfileSwitcher />
          <small>v{systemInfo?.version ?? '0.1.0'}</small>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <strong>
              {systemInfo?.environment === 'test'
                ? 'AMBIENTE DE TESTE'
                : cloudStatus?.connection === 'connected'
                  ? 'Operação conectada'
                  : 'Operação local'}
            </strong>
            <span>
              {systemInfo?.environment === 'test'
                ? 'Banco, fila e nuvem isolados da operação oficial'
                : sessionLoading
                  ? 'Carregando sessão local'
                  : (sessionError ??
                    (cloudStatus?.connection === 'connected'
                      ? 'Canal Cloudflare autenticado'
                      : 'Dados armazenados neste computador'))}
            </span>
          </div>

          <div className="topbar-status" aria-live="polite">
            {systemInfo?.environment === 'test' ? (
              <span className="status-pill status-pill--test">Teste isolado</span>
            ) : null}
            <span
              className={
                cloudStatus?.connection === 'connected'
                  ? 'status-pill status-pill--success'
                  : 'status-pill'
              }
            >
              {cloudStatus?.connection === 'connected' ? (
                <Cloud size={16} aria-hidden="true" />
              ) : (
                <WifiOff size={16} aria-hidden="true" />
              )}
              {cloudStatus?.connection === 'connected' ? 'Nuvem conectada' : 'Nuvem indisponível'}
            </span>
            <span
              className={
                systemInfo?.databaseReady === true
                  ? 'status-pill status-pill--success'
                  : 'status-pill status-pill--pending'
              }
              title={systemError ?? undefined}
            >
              <Database size={16} aria-hidden="true" />
              {systemError !== null
                ? 'Banco indisponível'
                : systemInfo?.databaseReady === true
                  ? 'Banco íntegro'
                  : 'Verificando banco'}
            </span>
          </div>
        </header>

        <main className="workspace-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
