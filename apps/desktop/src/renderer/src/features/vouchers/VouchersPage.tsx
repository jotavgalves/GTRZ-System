import { RefreshCw, Ticket, Trash2, TriangleAlert } from 'lucide-react';

import { VoucherCard } from './VoucherCard';
import { VoucherForm } from './VoucherForm';
import { VoucherHistory } from './VoucherHistory';
import { useVouchers } from './useVouchers';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function VouchersPage(): React.JSX.Element {
  const {
    state,
    loading,
    busy,
    error,
    message,
    reload,
    createVoucher,
    changeStatus,
    updateVoucher,
    addBalance,
    setVoucherTotal,
    deleteVoucher,
  } = useVouchers();
  const vouchers = state?.vouchers ?? [];
  const deletedVouchers = state?.deletedVouchers ?? [];
  const servicePoints = state?.servicePoints ?? [];
  const transactions = state?.transactions ?? [];
  const activeVouchers = vouchers.filter((voucher) => voucher.status === 'active');
  const cancelledVouchers = vouchers.filter((voucher) => voucher.status === 'cancelled');
  const availableCents = activeVouchers.reduce(
    (total, voucher) => total + voucher.remainingBalanceCents,
    0,
  );
  const hasActiveEvent = state?.activeEventId !== null && state !== null;
  const showMissingEventWarning =
    !loading && error === null && state !== null && state.activeEventId === null;

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Crédito controlado por evento e mesa</span>
          <h1>Vouchers</h1>
          <p>
            Emita créditos, vincule-os a uma mesa e acompanhe saldos sem permitir uso em outro
            atendimento.
          </p>
        </div>
        <button
          className="button button--secondary"
          disabled={loading || busy}
          onClick={() => {
            void reload();
          }}
          type="button"
        >
          <RefreshCw size={17} aria-hidden="true" />
          Atualizar
        </button>
      </header>

      <div className="summary-grid summary-grid--compact">
        <article className="summary-card">
          <span>Vouchers ativos</span>
          <strong>{activeVouchers.length}</strong>
        </article>
        <article className="summary-card summary-card--accent">
          <span>Saldo disponível</span>
          <strong>{formatMoney(availableCents)}</strong>
        </article>
        <article className="summary-card">
          <span>Mesas cadastradas</span>
          <strong>{servicePoints.length}</strong>
        </article>
        <article className="summary-card">
          <span>Cancelados</span>
          <strong>{cancelledVouchers.length}</strong>
        </article>
      </div>

      {showMissingEventWarning ? (
        <div className="inventory-warning">
          <TriangleAlert size={19} aria-hidden="true" />
          <span>Selecione um evento aberto antes de emitir vouchers.</span>
        </div>
      ) : null}

      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}

      {hasActiveEvent ? (
        <div className="voucher-layout">
          <article className="panel">
            <VoucherForm busy={busy} onSubmit={createVoucher} servicePoints={servicePoints} />
          </article>
          <div className="voucher-list" aria-live="polite">
            {loading ? <div className="route-state">Carregando vouchers…</div> : null}
            {!loading && vouchers.length === 0 ? (
              <div className="empty-state">
                <Ticket size={32} aria-hidden="true" />
                <h2>Nenhum voucher ativo no cadastro</h2>
                <p>Emita o primeiro crédito para uma mesa do evento.</p>
              </div>
            ) : null}
            {vouchers.map((voucher) => (
              <VoucherCard
                busy={busy}
                hasUsage={transactions.some(
                  (transaction) =>
                    transaction.voucherId === voucher.id && transaction.type === 'redemption',
                )}
                key={voucher.id}
                onAddBalance={addBalance}
                onSetTotal={setVoucherTotal}
                onChangeStatus={changeStatus}
                onDelete={deleteVoucher}
                onUpdate={updateVoucher}
                servicePoints={servicePoints}
                voucher={voucher}
              />
            ))}
          </div>
        </div>
      ) : null}

      {hasActiveEvent && deletedVouchers.length > 0 ? (
        <details className="panel voucher-deleted-list">
          <summary>
            <span>
              <Trash2 size={17} aria-hidden="true" />
              Excluídos
            </span>
            <strong>{deletedVouchers.length}</strong>
          </summary>
          <div className="voucher-list">
            {deletedVouchers.map((voucher) => (
              <VoucherCard
                busy={busy}
                hasUsage
                key={voucher.id}
                onAddBalance={addBalance}
                onSetTotal={setVoucherTotal}
                onChangeStatus={changeStatus}
                onDelete={deleteVoucher}
                onUpdate={updateVoucher}
                servicePoints={servicePoints}
                voucher={voucher}
              />
            ))}
          </div>
        </details>
      ) : null}

      {hasActiveEvent ? <VoucherHistory transactions={transactions} /> : null}
    </section>
  );
}
