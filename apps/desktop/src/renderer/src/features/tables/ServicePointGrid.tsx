import { Armchair, Pencil, Pin, PinOff, ShoppingBasket, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DeleteServicePointMode, ServicePoint } from '@gtrz/contracts';

interface ServicePointGridProps {
  readonly servicePoints: readonly ServicePoint[];
  readonly busy: boolean;
  readonly production: boolean;
  readonly onOpen: (servicePoint: ServicePoint) => Promise<void>;
  readonly onRenameServicePoint: (servicePointId: string, label: string) => Promise<void>;
  readonly onSetServicePointPinned: (servicePointId: string, pinned: boolean) => Promise<void>;
  readonly onDeleteServicePoint: (input: {
    readonly servicePointId: string;
    readonly mode: DeleteServicePointMode;
    readonly reason: string;
  }) => Promise<void>;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

type TableActionMode = 'rename' | 'delete' | null;

export function ServicePointGrid({
  servicePoints,
  busy,
  production,
  onOpen,
  onRenameServicePoint,
  onSetServicePointPinned,
  onDeleteServicePoint,
}: ServicePointGridProps): React.JSX.Element {
  const [actionServicePointId, setActionServicePointId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<TableActionMode>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteMode, setDeleteMode] = useState<DeleteServicePointMode>('keep-sales-history');

  useEffect(() => {
    if (actionServicePointId === null) return;
    if (servicePoints.some((servicePoint) => servicePoint.id === actionServicePointId)) return;
    setActionServicePointId(null);
    setActionMode(null);
    setRenameLabel('');
    setDeleteReason('');
  }, [actionServicePointId, servicePoints]);

  return (
    <div className="service-point-grid" aria-live="polite">
      {servicePoints.map((servicePoint) => {
        const Icon = servicePoint.type === 'counter' ? ShoppingBasket : Armchair;
        const open = servicePoint.status === 'open';
        const actionOpen = actionServicePointId === servicePoint.id;

        return (
          <article
            className={open ? 'service-point-card service-point-card--open' : 'service-point-card'}
            key={servicePoint.id}
          >
            <button
              className="service-point-card__open"
              disabled={busy}
              onClick={() => {
                void onOpen(servicePoint);
              }}
              type="button"
            >
              <span className="service-point-card__icon">
                <Icon size={22} aria-hidden="true" />
              </span>
              <span className="service-point-card__body">
                <strong>{servicePoint.label}</strong>
                <small>
                  {servicePoint.type === 'counter' ? 'Venda imediata' : 'Atendimento por mesa'}
                </small>
              </span>
              <span className={open ? 'status-badge status-badge--open' : 'status-badge'}>
                {open ? formatMoney(servicePoint.activeOrderTotalCents) : 'Livre'}
              </span>
              {servicePoint.pinned ? (
                <span className="service-point-card__pin" title="Mesa fixada">
                  <Pin size={14} aria-hidden="true" />
                </span>
              ) : null}
            </button>
            {production && servicePoint.type === 'table' ? (
              <div className="service-point-card__actions">
                <button
                  aria-label={servicePoint.pinned ? 'Desafixar mesa' : 'Fixar mesa'}
                  className="icon-button"
                  disabled={busy}
                  onClick={() => {
                    void onSetServicePointPinned(servicePoint.id, !servicePoint.pinned);
                  }}
                  title={servicePoint.pinned ? 'Desafixar mesa' : 'Fixar mesa'}
                  type="button"
                >
                  {servicePoint.pinned ? (
                    <PinOff size={15} aria-hidden="true" />
                  ) : (
                    <Pin size={15} aria-hidden="true" />
                  )}
                </button>
                <button
                  aria-label="Renomear mesa"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => {
                    setActionServicePointId(servicePoint.id);
                    setActionMode(actionOpen && actionMode === 'rename' ? null : 'rename');
                    setRenameLabel(servicePoint.label);
                    setDeleteReason('');
                  }}
                  title="Renomear mesa"
                  type="button"
                >
                  <Pencil size={15} aria-hidden="true" />
                </button>
                <button
                  aria-label="Excluir mesa"
                  className="icon-button icon-button--danger"
                  disabled={busy}
                  onClick={() => {
                    setActionServicePointId(servicePoint.id);
                    setActionMode(actionOpen && actionMode === 'delete' ? null : 'delete');
                    setRenameLabel(servicePoint.label);
                    setDeleteReason('');
                  }}
                  title="Excluir mesa"
                  type="button"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            {production &&
            servicePoint.type === 'table' &&
            actionOpen &&
            actionMode === 'rename' ? (
              <form
                className="service-point-card__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onRenameServicePoint(servicePoint.id, renameLabel).then(() => {
                    setActionMode(null);
                    setActionServicePointId(null);
                  });
                }}
              >
                <label className="form-field">
                  <span>Novo nome da mesa</span>
                  <input
                    disabled={busy}
                    maxLength={40}
                    onChange={(event) => {
                      setRenameLabel(event.target.value);
                    }}
                    value={renameLabel}
                  />
                </label>
                <button
                  className="button button--primary button--compact"
                  disabled={busy || renameLabel.trim().length === 0}
                  type="submit"
                >
                  Salvar
                </button>
              </form>
            ) : null}
            {production &&
            servicePoint.type === 'table' &&
            actionOpen &&
            actionMode === 'delete' ? (
              <form
                className="service-point-card__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onDeleteServicePoint({
                    servicePointId: servicePoint.id,
                    mode: deleteMode,
                    reason: deleteReason,
                  });
                }}
              >
                <label className="form-field">
                  <span>Opção de exclusão</span>
                  <select
                    disabled={busy}
                    onChange={(event) => {
                      setDeleteMode(event.target.value as DeleteServicePointMode);
                    }}
                    value={deleteMode}
                  >
                    <option value="keep-sales-history">Manter vendas</option>
                    <option value="delete-all">Excluir tudo</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>Motivo</span>
                  <input
                    disabled={busy}
                    maxLength={240}
                    onChange={(event) => {
                      setDeleteReason(event.target.value);
                    }}
                    placeholder="Motivo da exclusão"
                    value={deleteReason}
                  />
                </label>
                <button
                  className="button button--danger button--compact"
                  disabled={busy || deleteReason.trim().length < 3}
                  type="submit"
                >
                  Excluir mesa
                </button>
              </form>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
