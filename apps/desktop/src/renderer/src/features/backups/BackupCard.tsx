import { CheckCircle2, FileArchive, RefreshCw, ShieldAlert } from 'lucide-react';

import type { BackupKind, BackupRecord } from '@gtrz/contracts';

interface BackupCardProps {
  readonly record: BackupRecord;
  readonly busy: boolean;
  readonly onVerify: (record: BackupRecord) => Promise<void>;
}

const KIND_LABELS: Readonly<Record<BackupKind, string>> = {
  automatic: 'Automático',
  'event-close': 'Encerramento do evento',
  manual: 'Manual',
  'pre-restore': 'Antes da restauração',
  'pre-event-reset': 'Antes de zerar o evento',
};

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(timestamp);
}

function formatSize(bytes: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'unit',
    unit: bytes >= 1_048_576 ? 'megabyte' : 'kilobyte',
    unitDisplay: 'short',
    maximumFractionDigits: 2,
  }).format(bytes >= 1_048_576 ? bytes / 1_048_576 : bytes / 1024);
}

export function BackupCard({ record, busy, onVerify }: BackupCardProps): React.JSX.Element {
  const valid = record.integrity === 'valid';

  return (
    <article className={valid ? 'backup-card' : 'backup-card backup-card--invalid'}>
      <div className="backup-card__icon" aria-hidden="true">
        <FileArchive size={22} />
      </div>
      <div className="backup-card__content">
        <div className="backup-card__heading">
          <div>
            <strong>{record.fileName}</strong>
            <span>{KIND_LABELS[record.kind]}</span>
          </div>
          <span className={valid ? 'integrity-chip integrity-chip--valid' : 'integrity-chip'}>
            {valid ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
            {valid ? 'Íntegro' : 'Inválido'}
          </span>
        </div>
        <div className="backup-card__meta">
          <span>{formatDate(record.createdAt)}</span>
          <span>{formatSize(record.sizeBytes)}</span>
        </div>
      </div>
      <button
        className="button button--ghost button--compact"
        disabled={busy}
        onClick={() => {
          void onVerify(record);
        }}
        type="button"
      >
        <RefreshCw size={15} aria-hidden="true" />
        Verificar
      </button>
    </article>
  );
}
