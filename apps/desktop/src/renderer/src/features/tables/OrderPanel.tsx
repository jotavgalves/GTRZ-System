import { ArrowLeft, ReceiptText, Trash2 } from 'lucide-react';

import type { CloseOrderInput, OperationCatalogItem, Order, ServicePoint } from '@gtrz/contracts';

import { ProductVisual } from '../../shared/product/ProductVisual';
import { CancellationForm } from './CancellationForm';
import { CheckoutForm } from './CheckoutForm';
import { RecentOrdersPanel } from './RecentOrdersPanel';

interface OrderPanelProps {
  readonly servicePoint: ServicePoint;
  readonly order: Order | null;
  readonly history: readonly Order[];
  readonly catalog: readonly OperationCatalogItem[];
  readonly busy: boolean;
  readonly production: boolean;
  readonly onBack: () => void;
  readonly onRemoveItem: (orderItemId: string) => Promise<void>;
  readonly onBindVoucher: (code: string) => Promise<void>;
  readonly onUnbindVoucher: () => Promise<void>;
  readonly onCloseOrder: (input: Omit<CloseOrderInput, 'orderId'>) => Promise<void>;
  readonly onCancelOrder: (orderId: string, reason: string) => Promise<void>;
  readonly onReprintOrder: (orderId: string) => Promise<void>;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

export function OrderPanel({
  servicePoint,
  order,
  history,
  catalog,
  busy,
  production,
  onBack,
  onRemoveItem,
  onBindVoucher,
  onUnbindVoucher,
  onCloseOrder,
  onCancelOrder,
  onReprintOrder,
}: OrderPanelProps): React.JSX.Element {
  return (
    <article className="panel order-panel">
      <div className="order-panel__header">
        <button
          aria-label="Voltar para mesas"
          className="icon-button order-panel__back"
          disabled={busy}
          onClick={onBack}
          title="Voltar para mesas"
          type="button"
        >
          <ArrowLeft size={17} aria-hidden="true" />
        </button>
        <div className="panel__heading">
          <ReceiptText size={20} aria-hidden="true" />
          <div>
            <h2>{servicePoint.label}</h2>
            <p>
              {order === null
                ? 'Selecione o primeiro item. A comanda só será criada quando houver algo nela.'
                : 'Comanda aberta · os preços ficam congelados ao adicionar cada item.'}
            </p>
          </div>
        </div>
      </div>

      {order === null ? (
        <div className="operation-empty order-panel__empty-order">
          Nenhuma comanda aberta. Adicionar o primeiro produto ou combo inicia a venda.
        </div>
      ) : (
        <>
          <div className="order-items">
            {order.items.map((item) => {
              const catalogItem = catalog.find(
                (candidate) => candidate.id === item.itemId && candidate.kind === item.itemKind,
              );
              return (
                <div className="order-item" key={item.id}>
                  {catalogItem === undefined ? null : (
                    <ProductVisual
                      alt={item.itemName}
                      fallbackIcon={catalogItem.fallbackIcon}
                      imageDataUrl={catalogItem.imageDataUrl}
                      size="small"
                    />
                  )}
                  <span>
                    <strong>{item.itemName}</strong>
                    <small>
                      {item.quantity} × {formatMoney(item.unitPriceCents)}
                    </small>
                    {item.componentAllocations.filter(
                      (allocation) => allocation.choiceGroup !== null,
                    ).length === 0 ? null : (
                      <small>
                        Escolhas:{' '}
                        {item.componentAllocations
                          .filter((allocation) => allocation.choiceGroup !== null)
                          .map((allocation) => `${allocation.quantity}× ${allocation.productName}`)
                          .join(' · ')}
                      </small>
                    )}
                  </span>
                  <strong>{formatMoney(item.totalCents)}</strong>
                  <button
                    aria-label={`Remover ${item.itemName}`}
                    className="icon-button"
                    disabled={busy}
                    onClick={() => void onRemoveItem(item.id)}
                    type="button"
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="order-summary">
            <span>Subtotal</span>
            <strong>{formatMoney(order.subtotalCents)}</strong>
          </div>
          <CheckoutForm
            busy={busy}
            onBindVoucher={onBindVoucher}
            onClose={onCloseOrder}
            onUnbindVoucher={onUnbindVoucher}
            order={order}
          />
          {production ? (
            <div className="order-cancellation">
              <CancellationForm
                busy={busy}
                label="Cancelar comanda"
                onSubmit={(reason) => onCancelOrder(order.id, reason)}
              />
            </div>
          ) : null}
        </>
      )}

      <RecentOrdersPanel
        busy={busy}
        canCancel={production}
        onCancel={onCancelOrder}
        onReprint={onReprintOrder}
        orders={history}
        title={`Histórico de ${servicePoint.label}`}
      />
    </article>
  );
}
