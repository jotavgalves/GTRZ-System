import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  RefreshCw,
  Settings2,
  Trash2,
  WalletCards,
} from 'lucide-react';
import { useState } from 'react';

import type {
  AddVoucherBalanceInput,
  DeleteVoucherInput,
  UpdateVoucherInput,
  Voucher,
  VoucherServicePoint,
} from '@gtrz/contracts';

interface VoucherCardProps {
  readonly voucher: Voucher;
  readonly servicePoints: readonly VoucherServicePoint[];
  readonly hasUsage: boolean;
  readonly busy: boolean;
  readonly onChangeStatus: (voucherId: string, status: 'active' | 'cancelled') => Promise<void>;
  readonly onUpdate: (input: UpdateVoucherInput) => Promise<void>;
  readonly onAddBalance: (input: AddVoucherBalanceInput) => Promise<void>;
  readonly onDelete: (input: DeleteVoucherInput) => Promise<void>;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

function parseMoney(value: string): number {
  const amount = Number(value.trim().replace(',', '.'));
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

const STATUS_LABELS = {
  active: 'Ativo',
  exhausted: 'Esgotado',
  cancelled: 'Cancelado',
} as const;

export function VoucherCard({
  voucher,
  servicePoints,
  hasUsage,
  busy,
  onChangeStatus,
  onUpdate,
  onAddBalance,
  onDelete,
}: VoucherCardProps): React.JSX.Element {
  const [managerOpen, setManagerOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editLabel, setEditLabel] = useState(voucher.label);
  const [editCode, setEditCode] = useState(voucher.code);
  const [editServicePointId, setEditServicePointId] = useState(
    voucher.servicePointActive ? (voucher.servicePointId ?? '') : '',
  );
  const [balanceToAdd, setBalanceToAdd] = useState('');
  const [deleteReason, setDeleteReason] = useState('');

  const isDeleted = voucher.deletedAt !== null;
  const tableLabel =
    voucher.servicePointLabel === null
      ? 'Sem mesa vinculada'
      : voucher.servicePointActive
        ? voucher.servicePointLabel
        : `${voucher.servicePointLabel} · mesa removida`;

  return (
    <article className={isDeleted ? 'voucher-card voucher-card--deleted' : 'voucher-card'}>
      <header className="voucher-card__header">
        <span>
          <strong>{voucher.label}</strong>
          <code>{voucher.code}</code>
        </span>
        <span
          className={
            voucher.status === 'active' && !isDeleted
              ? 'status-badge status-badge--open'
              : 'status-badge status-badge--archived'
          }
        >
          {isDeleted ? 'Excluído' : STATUS_LABELS[voucher.status]}
        </span>
      </header>

      <div className="voucher-card__meta">
        <span>Mesa</span>
        <strong>{tableLabel}</strong>
      </div>

      <div className="voucher-card__balance">
        <span>Saldo disponível</span>
        <strong>{formatMoney(voucher.remainingBalanceCents)}</strong>
        <small>Emitido com {formatMoney(voucher.initialBalanceCents)}</small>
      </div>

      {isDeleted ? null : (
        <div className="voucher-card__actions">
          <button
            className="button button--ghost button--compact"
            disabled={busy}
            onClick={() => {
              void navigator.clipboard.writeText(voucher.code);
            }}
            type="button"
          >
            <Copy size={15} aria-hidden="true" />
            Copiar código
          </button>
          <button
            className="button button--ghost button--compact"
            disabled={busy}
            onClick={() => {
              setManagerOpen((current) => !current);
              setDeleteOpen(false);
            }}
            type="button"
          >
            <Settings2 size={15} aria-hidden="true" />
            Gerenciar
            {managerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {voucher.status === 'active' ? (
            <button
              className="button button--ghost button--compact"
              disabled={busy}
              onClick={() => {
                void onChangeStatus(voucher.id, 'cancelled');
              }}
              type="button"
            >
              <Ban size={15} aria-hidden="true" />
              Cancelar
            </button>
          ) : null}
          {voucher.status === 'cancelled' && voucher.remainingBalanceCents > 0 ? (
            <button
              className="button button--secondary button--compact"
              disabled={busy}
              onClick={() => {
                void onChangeStatus(voucher.id, 'active');
              }}
              type="button"
            >
              <RefreshCw size={15} aria-hidden="true" />
              Reativar
            </button>
          ) : null}
          {voucher.status === 'exhausted' ? (
            <span className="voucher-card__complete">
              <CheckCircle2 size={15} aria-hidden="true" />
              Saldo consumido
            </span>
          ) : null}
          <button
            className="button button--danger button--compact"
            disabled={busy}
            onClick={() => {
              setDeleteOpen((current) => !current);
              setManagerOpen(false);
            }}
            type="button"
          >
            <Trash2 size={15} aria-hidden="true" />
            Excluir
          </button>
        </div>
      )}

      {managerOpen && !isDeleted ? (
        <div className="voucher-manager">
          <div className="voucher-manager__section">
            <strong>Dados do voucher</strong>
            <label className="form-field">
              <span>Identificação</span>
              <input
                disabled={busy}
                maxLength={100}
                onChange={(event) => {
                  setEditLabel(event.target.value);
                }}
                value={editLabel}
              />
            </label>
            <label className="form-field">
              <span>Código</span>
              <input
                disabled={busy}
                maxLength={32}
                onChange={(event) => {
                  setEditCode(event.target.value.toLocaleUpperCase('pt-BR'));
                }}
                value={editCode}
              />
            </label>
            <label className="form-field">
              <span>Mesa vinculada</span>
              <select
                disabled={busy || voucher.servicePointActive}
                onChange={(event) => {
                  setEditServicePointId(event.target.value);
                }}
                value={editServicePointId}
              >
                <option value="">Selecione a mesa</option>
                {servicePoints.map((servicePoint) => (
                  <option key={servicePoint.id} value={servicePoint.id}>
                    {servicePoint.label}
                  </option>
                ))}
              </select>
            </label>
            {voucher.servicePointActive ? (
              <small className="form-hint">
                O vínculo com {voucher.servicePointLabel} fica bloqueado enquanto essa mesa existir.
              </small>
            ) : (
              <small className="form-hint">
                A mesa original não está mais ativa. Você pode reassociar o voucher.
              </small>
            )}
            <button
              className="button button--secondary button--compact"
              disabled={
                busy ||
                editLabel.trim().length < 2 ||
                editCode.trim().length < 4 ||
                editServicePointId.length === 0
              }
              onClick={() => {
                void onUpdate({
                  voucherId: voucher.id,
                  label: editLabel.trim(),
                  code: editCode.trim(),
                  servicePointId: editServicePointId,
                });
              }}
              type="button"
            >
              Salvar alterações
            </button>
          </div>

          <div className="voucher-manager__section">
            <strong>Adicionar saldo</strong>
            <div className="voucher-manager__inline">
              <label className="form-field">
                <span>Valor</span>
                <input
                  disabled={busy}
                  inputMode="decimal"
                  onChange={(event) => {
                    setBalanceToAdd(event.target.value);
                  }}
                  placeholder="50,00"
                  value={balanceToAdd}
                />
              </label>
              <button
                className="button button--secondary button--compact"
                disabled={busy || parseMoney(balanceToAdd) <= 0}
                onClick={() => {
                  void onAddBalance({
                    voucherId: voucher.id,
                    amountCents: parseMoney(balanceToAdd),
                  }).then(() => {
                    setBalanceToAdd('');
                  });
                }}
                type="button"
              >
                <WalletCards size={15} aria-hidden="true" />
                Adicionar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteOpen && !isDeleted ? (
        <div className="voucher-manager voucher-manager--delete">
          <div className="voucher-manager__section voucher-manager__danger">
            <strong>Excluir voucher</strong>
            <p>
              {hasUsage
                ? 'Este voucher já foi usado. A exclusão estornará as vendas pagas relacionadas, restaurará estoque e saldo e moverá o voucher para Excluídos.'
                : 'Este voucher nunca foi usado. A exclusão removerá definitivamente o cadastro.'}
            </p>
            <label className="form-field">
              <span>Motivo</span>
              <input
                disabled={busy}
                maxLength={250}
                onChange={(event) => {
                  setDeleteReason(event.target.value);
                }}
                placeholder="Informe por que o voucher será excluído"
                value={deleteReason}
              />
            </label>
            <button
              className="button button--danger button--compact"
              disabled={busy || deleteReason.trim().length < 2}
              onClick={() => {
                void onDelete({ voucherId: voucher.id, reason: deleteReason.trim() });
              }}
              type="button"
            >
              <Trash2 size={15} aria-hidden="true" />
              {hasUsage ? 'Estornar vendas e excluir' : 'Excluir definitivamente'}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
