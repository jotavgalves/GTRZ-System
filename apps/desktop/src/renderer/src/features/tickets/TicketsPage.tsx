import { RefreshCw, Ticket, TriangleAlert } from 'lucide-react';

import { TicketLotCard } from './TicketLotCard';
import { TicketLotForm } from './TicketLotForm';
import { TicketSaleCard } from './TicketSaleCard';
import { TicketSaleForm } from './TicketSaleForm';
import { useTickets } from './useTickets';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function TicketsPage(): React.JSX.Element {
  const {
    state,
    loading,
    busy,
    error,
    message,
    reload,
    createLot,
    updateLot,
    deleteLot,
    createSale,
    cancelSale,
    deleteSale,
  } = useTickets();
  if (loading && state === null) {
    return <div className="route-state">Carregando ingressos…</div>;
  }
  const lots = state?.lots ?? [];
  const sales = state?.sales ?? [];
  const activeSales = sales.filter((sale) => sale.status === 'active');
  const soldQuantity = activeSales
    .filter((sale) => sale.source !== 'courtesy')
    .reduce((total, sale) => total + sale.quantity, 0);
  const courtesyQuantity = activeSales
    .filter((sale) => sale.source === 'courtesy')
    .reduce((total, sale) => total + sale.quantity, 0);
  const availableQuantity = lots
    .filter((lot) => lot.active)
    .reduce((total, lot) => total + lot.availableQuantity, 0);

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Lotes, códigos e receita integrados</span>
          <h1>Ingressos</h1>
          <p>
            Cancelar preserva o registro. Excluir desfaz a venda quando necessário e remove seus
            códigos definitivamente.
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
          <span>Ingressos vendidos</span>
          <strong>{soldQuantity}</strong>
        </article>
        <article className="summary-card">
          <span>Cortesias ativas</span>
          <strong>{courtesyQuantity}</strong>
        </article>
        <article className="summary-card">
          <span>Disponíveis</span>
          <strong>{availableQuantity}</strong>
        </article>
        <article className="summary-card summary-card--accent">
          <span>Receita ativa</span>
          <strong>{formatMoney(state?.activeRevenueCents ?? 0)}</strong>
        </article>
      </div>

      {state?.activeEventId === null || state === null ? (
        <div className="inventory-warning">
          <TriangleAlert size={19} aria-hidden="true" />
          <span>Selecione um evento aberto antes de administrar ingressos.</span>
        </div>
      ) : null}

      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}

      {state?.activeEventId !== null && state !== null ? (
        <>
          <div className="ticket-admin-grid">
            <article className="panel">
              <TicketLotForm busy={busy} onSubmit={createLot} />
            </article>
            <article className="panel">
              <TicketSaleForm busy={busy} lots={lots} onSubmit={createSale} />
            </article>
          </div>

          <div className="ticket-lot-list">
            {lots.map((lot) => (
              <TicketLotCard
                busy={busy}
                key={lot.id}
                lot={lot}
                onDelete={deleteLot}
                onUpdate={updateLot}
              />
            ))}
          </div>

          <article className="panel ticket-history-panel">
            <div className="panel__heading">
              <Ticket size={20} aria-hidden="true" />
              <div>
                <h2>Vendas e cortesias</h2>
                <p>Use Gerenciar para cancelar ou excluir definitivamente.</p>
              </div>
            </div>
            {loading ? <div className="route-state">Carregando ingressos…</div> : null}
            {!loading && sales.length === 0 ? (
              <div className="empty-state">
                <Ticket size={32} aria-hidden="true" />
                <h2>Nenhum ingresso registrado</h2>
                <p>Crie um lote e registre a primeira venda ou cortesia.</p>
              </div>
            ) : null}
            <div className="ticket-sale-list">
              {sales.map((sale) => (
                <TicketSaleCard
                  busy={busy}
                  key={sale.id}
                  onCancel={cancelSale}
                  onDelete={deleteSale}
                  sale={sale}
                />
              ))}
            </div>
          </article>
        </>
      ) : null}
    </section>
  );
}
