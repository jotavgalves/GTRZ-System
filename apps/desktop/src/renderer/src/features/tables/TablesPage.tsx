import { RefreshCw, TableProperties, TriangleAlert } from 'lucide-react';

import { useSession } from '../../shared/session/session-context';
import { CatalogPanel } from './CatalogPanel';
import { CreateTableForm } from './CreateTableForm';
import { OrderPanel } from './OrderPanel';
import { RecentOrdersPanel } from './RecentOrdersPanel';
import { ServicePointGrid } from './ServicePointGrid';
import { useOperations } from './useOperations';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

export function TablesPage(): React.JSX.Element {
  const { state: sessionState } = useSession();
  const {
    state,
    order,
    selectedServicePoint,
    loading,
    busy,
    error,
    message,
    reload,
    createTable,
    renameServicePoint,
    setServicePointPinned,
    deleteServicePoint,
    openServicePoint,
    addItem,
    removeItem,
    bindVoucher,
    unbindVoucher,
    closeCurrentOrder,
    cancelOrder,
    reprintOrder,
    clearOrder,
  } = useOperations();
  const production = sessionState?.profile === 'production';
  const servicePoints = state?.servicePoints ?? [];
  const catalog = state?.catalog ?? [];
  const recentOrders = state?.recentOrders ?? [];
  const openPoints = servicePoints.filter((item) => item.status === 'open');
  const openTotalCents = openPoints.reduce((total, item) => total + item.activeOrderTotalCents, 0);
  const availableItems = catalog.filter((item) => item.active && item.availableQuantity > 0).length;
  const selectedHistory =
    selectedServicePoint === null
      ? []
      : recentOrders.filter((item) => item.servicePointId === selectedServicePoint.id);

  if (loading && state === null) {
    return (
      <section className="feature-page">
        <div className="route-state">Preparando mesas e balcão…</div>
      </section>
    );
  }

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Operação completa do evento</span>
          <h1>Mesas e balcão</h1>
          <p>Abra comandas, adicione produtos ou combos e conclua pagamentos simples ou mistos.</p>
        </div>
        <button
          className="button button--secondary"
          disabled={loading || busy}
          onClick={() => void reload()}
          type="button"
        >
          <RefreshCw size={17} aria-hidden="true" />
          Atualizar
        </button>
      </header>
      <div className="summary-grid summary-grid--compact">
        <article className="summary-card">
          <span>Pontos de atendimento</span>
          <strong>{servicePoints.length}</strong>
        </article>
        <article className="summary-card">
          <span>Comandas abertas</span>
          <strong>{openPoints.length}</strong>
        </article>
        <article className="summary-card">
          <span>Valor em aberto</span>
          <strong>{formatMoney(openTotalCents)}</strong>
        </article>
        <article className="summary-card summary-card--accent">
          <span>Opções à venda</span>
          <strong>{availableItems}</strong>
          <small>Produtos e combos ativos com estoque</small>
        </article>
      </div>
      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}
      {state?.activeEventId === null || state === null ? (
        <div className="inventory-warning">
          <TriangleAlert size={19} aria-hidden="true" />
          <span>Selecione um evento aberto antes de operar mesas e vendas.</span>
        </div>
      ) : null}
      {state?.activeEventId !== null && state !== null && selectedServicePoint === null ? (
        <>
          {production ? (
            <article className="panel table-creation-panel">
              <div className="panel__heading">
                <TableProperties size={20} aria-hidden="true" />
                <div>
                  <h2>Nova mesa</h2>
                  <p>O balcão permanente é criado automaticamente para cada evento.</p>
                </div>
              </div>
              <CreateTableForm busy={busy} onSubmit={createTable} />
            </article>
          ) : null}
          {loading ? <div className="route-state">Carregando operação…</div> : null}
          {!loading ? (
            <ServicePointGrid
              busy={busy}
              onDeleteServicePoint={deleteServicePoint}
              onOpen={openServicePoint}
              onRenameServicePoint={renameServicePoint}
              onSetServicePointPinned={setServicePointPinned}
              production={production}
              servicePoints={servicePoints}
            />
          ) : null}
          {!loading ? (
            <RecentOrdersPanel
              busy={busy}
              canCancel={production}
              onCancel={cancelOrder}
              onReprint={reprintOrder}
              orders={recentOrders}
              title="Histórico de vendas do evento"
            />
          ) : null}
        </>
      ) : null}
      {selectedServicePoint === null ? null : (
        <div className="operation-workspace">
          <CatalogPanel busy={busy} items={catalog} onAdd={addItem} />
          <OrderPanel
            busy={busy}
            catalog={catalog}
            history={selectedHistory}
            onBack={clearOrder}
            onBindVoucher={bindVoucher}
            onCancelOrder={cancelOrder}
            onCloseOrder={closeCurrentOrder}
            onRemoveItem={removeItem}
            onReprintOrder={reprintOrder}
            onUnbindVoucher={unbindVoucher}
            order={order}
            production={production}
            servicePoint={selectedServicePoint}
          />
        </div>
      )}
    </section>
  );
}
