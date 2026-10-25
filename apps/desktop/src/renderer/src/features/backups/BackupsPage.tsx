import {
  ArchiveRestore,
  FolderCog,
  HardDriveDownload,
  Import,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

import { BackupCard } from './BackupCard';
import { useBackups } from './useBackups';

function formatDate(timestamp: number | undefined): string {
  if (timestamp === undefined) {
    return 'Nunca';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(timestamp);
}

export function BackupsPage(): React.JSX.Element {
  const {
    state,
    loading,
    busy,
    error,
    message,
    reload,
    chooseDestination,
    createManual,
    importBackup,
    verify,
  } = useBackups();
  const latestBackup = state?.backups.find((backup) => backup.integrity === 'valid');
  const invalidCount =
    state?.backups.filter((backup) => backup.integrity === 'invalid').length ?? 0;

  async function confirmImport(): Promise<void> {
    const confirmed = window.confirm(
      'A importação substituirá o banco atual. Um backup preventivo será criado antes da troca. Deseja continuar?',
    );

    if (confirmed) {
      await importBackup();
    }
  }

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Proteção do banco local</span>
          <h1>Backups</h1>
          <p>
            Crie, verifique e importe pacotes completos do GTRZ System em pasta local, pendrive ou
            HD externo.
          </p>
        </div>
        <div className="feature-actions">
          <button
            className="button button--secondary"
            disabled={busy || loading}
            onClick={() => {
              void reload();
            }}
            type="button"
          >
            <RefreshCw size={17} aria-hidden="true" />
            Atualizar
          </button>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() => {
              void createManual();
            }}
            type="button"
          >
            <HardDriveDownload size={17} aria-hidden="true" />
            Criar backup
          </button>
        </div>
      </header>

      <div className="summary-grid summary-grid--compact">
        <article className="summary-card summary-card--accent">
          <span>Último backup íntegro</span>
          <strong>{formatDate(latestBackup?.createdAt)}</strong>
        </article>
        <article className="summary-card">
          <span>Pacotes encontrados</span>
          <strong>{state?.backups.length ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Arquivos inválidos</span>
          <strong>{invalidCount}</strong>
        </article>
        <article className="summary-card">
          <span>Proteção automática</span>
          <strong>A cada 2 h</strong>
        </article>
      </div>

      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}

      <div className="backup-layout">
        <aside className="panel backup-settings">
          <div className="panel__heading">
            <FolderCog size={20} aria-hidden="true" />
            <div>
              <h2>Destino configurado</h2>
              <p>Escolha uma pasta fixa, pendrive ou HD externo.</p>
            </div>
          </div>
          <code className="backup-destination">
            {state?.destinationPath ?? 'Carregando pasta de destino…'}
          </code>
          <button
            className="button button--secondary"
            disabled={busy}
            onClick={() => {
              void chooseDestination();
            }}
            type="button"
          >
            <FolderCog size={17} aria-hidden="true" />
            Alterar destino
          </button>

          <div className="backup-protection-note">
            <ShieldCheck size={20} aria-hidden="true" />
            <p>
              Cada pacote recebe checksum SHA-256 e contém um snapshot SQLite verificado antes de
              ser aceito.
            </p>
          </div>

          <button
            className="button button--ghost"
            disabled={busy}
            onClick={() => {
              void confirmImport();
            }}
            type="button"
          >
            <Import size={17} aria-hidden="true" />
            Importar e restaurar
          </button>
        </aside>

        <div className="backup-list" aria-live="polite">
          {loading ? <div className="route-state">Carregando backups…</div> : null}
          {!loading && state?.backups.length === 0 ? (
            <div className="empty-state">
              <ArchiveRestore size={32} aria-hidden="true" />
              <h2>Nenhum backup encontrado</h2>
              <p>Crie o primeiro pacote manual ou aguarde o backup automático.</p>
            </div>
          ) : null}
          {state?.backups.map((record) => (
            <BackupCard busy={busy} key={record.filePath} onVerify={verify} record={record} />
          ))}
        </div>
      </div>
    </section>
  );
}
