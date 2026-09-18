import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDollarSign,
  ClipboardList,
  Pencil,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type {
  DeleteProductInput,
  InventoryProduct,
  ProductCategory,
  ProductDeletionImpact,
  RecordStockMovementInput,
  StockPurchaseLot,
  UpdateProductInput,
} from '@gtrz/contracts';

import { ProductVisual } from '../../shared/product/ProductVisual';
import { ProductForm } from './ProductForm';
import { StockMovementForm } from './StockMovementForm';

interface ProductCardProps {
  readonly product: InventoryProduct;
  readonly categories: readonly ProductCategory[];
  readonly production: boolean;
  readonly hasActiveEvent: boolean;
  readonly busy: boolean;
  readonly onUpdate: (input: UpdateProductInput) => Promise<void>;
  readonly onMovement: (input: RecordStockMovementInput) => Promise<void>;
  readonly onPreviewDeletion: (productId: string) => Promise<ProductDeletionImpact>;
  readonly onDelete: (input: DeleteProductInput) => Promise<void>;
  readonly onChanged: () => Promise<void>;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function parseMoney(value: string): number {
  const amount = Number(value.trim().replace(',', '.'));
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(value);
}

function PurchaseLotsPanel({
  product,
  busy,
  onCancel,
  onChanged,
}: {
  readonly product: InventoryProduct;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [lots, setLots] = useState<readonly StockPurchaseLot[]>([]);
  const [editing, setEditing] = useState<StockPurchaseLot | null>(null);
  const [voiding, setVoiding] = useState<StockPurchaseLot | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.gtrz.inventory.listPurchaseLots(product.id).then(setLots).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : 'Não foi possível carregar os lotes.');
    });
  }, [product.id]);
  async function correctLot(): Promise<void> {
    if (editing === null) return;
    try {
      const totalCostCents = parseMoney(amount);
      await window.gtrz.inventory.correctPurchaseLot({
        movementId: editing.movementId,
        totalCostCents,
        reason: reason.trim(),
      });
      setLots(await window.gtrz.inventory.listPurchaseLots(product.id));
      await onChanged();
      setEditing(null);
      setAmount('');
      setReason('');
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : 'Não foi possível corrigir o lote.');
    }
  }
  async function voidLot(): Promise<void> {
    if (voiding === null) return;
    try {
      await window.gtrz.inventory.voidPurchaseLot({ movementId: voiding.movementId, reason: reason.trim() });
      setLots(await window.gtrz.inventory.listPurchaseLots(product.id));
      await onChanged();
      setVoiding(null);
      setReason('');
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : 'Não foi possível desfazer a entrada.');
    }
  }
  return (
    <article className="inventory-card inventory-card--expanded">
      <div className="movement-form__heading">
        <div><span>Lotes de compra</span><strong>{product.name}</strong></div>
        <button className="button button--ghost button--compact" onClick={onCancel} type="button"><X size={15} aria-hidden="true" />Fechar</button>
      </div>
      <p className="form-hint">Cada linha é uma compra. Corrigir o valor preserva o lançamento original no diário.</p>
      {error === null ? null : <p className="form-error">{error}</p>}
      {lots.length === 0 ? <p className="inventory-helper">Ainda não há compras com valor registrado neste evento.</p> : null}
      <div className="expense-list">
        {lots.map((lot) => (
          <article className="expense-card expense-card--compact" key={lot.movementId}>
            <header className="expense-card__header"><span><strong>{lot.quantity} un. por {formatMoney(lot.unitCostCents)}</strong><small>{formatDate(lot.createdAt)}</small></span><strong>{formatMoney(lot.totalCostCents)}</strong></header>
            {lot.voided ? <p className="form-hint">Entrada desfeita.</p> : <div className="product-form__actions"><button className="button button--secondary button--compact" disabled={busy} onClick={() => { setEditing(lot); setAmount((lot.totalCostCents / 100).toFixed(2).replace('.', ',')); setReason(''); setError(null); }} type="button">Corrigir valor</button><button className="button button--ghost button--compact" disabled={busy || !lot.canUndo} onClick={() => { setVoiding(lot); setReason(''); setError(null); }} title={lot.canUndo ? 'Desfaz esta entrada e registra a compensação.' : 'Há baixas posteriores; não é seguro desfazer esta entrada.'} type="button">Desfazer entrada</button></div>}
          </article>
        ))}
      </div>
      {editing === null ? null : <form className="movement-form" onSubmit={(event) => { event.preventDefault(); void correctLot(); }}>
        <strong>Corrigir compra de {editing.quantity} un.</strong>
        <div className="movement-form__grid"><label className="form-field"><span>Valor total correto</span><input autoFocus inputMode="decimal" onChange={(event) => setAmount(event.target.value)} required value={amount} /></label><label className="form-field"><span>Motivo</span><input maxLength={240} onChange={(event) => setReason(event.target.value)} required value={reason} /></label></div>
        <div className="product-form__actions"><button className="button button--ghost" onClick={() => setEditing(null)} type="button">Cancelar</button><button className="button button--primary" disabled={busy || parseMoney(amount) <= 0 || reason.trim().length < 3} type="submit">Salvar correção</button></div>
      </form>}
      {voiding === null ? null : <form className="movement-form" onSubmit={(event) => { event.preventDefault(); void voidLot(); }}>
        <strong>Desfazer entrada de {voiding.quantity} un.</strong>
        <p className="form-hint">A quantidade será baixada e a compra deixará de contar no custo do evento. O lançamento original será preservado no diário.</p>
        <label className="form-field"><span>Motivo</span><input autoFocus maxLength={240} onChange={(event) => setReason(event.target.value)} required value={reason} /></label>
        <div className="product-form__actions"><button className="button button--ghost" onClick={() => setVoiding(null)} type="button">Cancelar</button><button className="button button--danger" disabled={busy || reason.trim().length < 3} type="submit">Desfazer entrada</button></div>
      </form>}
    </article>
  );
}

export function ProductCard({
  product,
  categories,
  production,
  hasActiveEvent,
  busy,
  onUpdate,
  onMovement,
  onPreviewDeletion,
  onDelete,
  onChanged,
}: ProductCardProps): React.JSX.Element {
  const [mode, setMode] = useState<'view' | 'edit' | 'entry' | 'decrease' | 'lots' | 'delete'>('view');
  const [impact, setImpact] = useState<ProductDeletionImpact | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (mode === 'edit') {
    return (
      <article className="inventory-card inventory-card--expanded">
        <ProductForm
          busy={busy}
          categories={categories}
          onCancel={() => {
            setMode('view');
          }}
          onSubmit={async (input) => {
            await onUpdate(input);
            setMode('view');
          }}
          product={product}
        />
      </article>
    );
  }
  if (mode === 'entry' || mode === 'decrease') {
    return (
      <article className="inventory-card inventory-card--expanded">
        <StockMovementForm
          busy={busy}
          intent={mode}
          onCancel={() => {
            setMode('view');
          }}
          onSubmit={onMovement}
          product={product}
        />
      </article>
    );
  }
  if (mode === 'lots') {
    return <PurchaseLotsPanel busy={busy} onCancel={() => setMode('view')} onChanged={onChanged} product={product} />;
  }
  if (mode === 'delete') {
    return (
      <article className="inventory-card inventory-card--expanded product-delete-panel">
        <div className="product-delete-panel__heading">
          <Trash2 size={19} aria-hidden="true" />
          <div>
            <h2>Excluir {product.name}</h2>
            <p>Escolha exatamente o que deve acontecer com as vendas já realizadas.</p>
          </div>
        </div>
        {impact === null ? (
          <p>Carregando impacto…</p>
        ) : (
          <div className="product-delete-impact">
            <span>
              Estoque atual<strong>{impact.currentQuantity} un.</strong>
            </span>
            <span>
              Vendas pagas neste evento<strong>{impact.paidOrdersInActiveEventCount}</strong>
            </span>
            <span>
              Vendas históricas<strong>{impact.paidOrdersHistoricalCount}</strong>
            </span>
            <span>
              Combos afetados<strong>{impact.affectedCombosCount}</strong>
            </span>
          </div>
        )}
        {impact?.openOrdersCount === 0 ? null : (
          <p className="form-error">
            Há {impact?.openOrdersCount} comanda(s) aberta(s) usando este produto. Remova o item
            dessas comandas antes de excluir.
          </p>
        )}
        <label className="form-field">
          <span>Motivo da exclusão</span>
          <input
            maxLength={240}
            onChange={(event) => {
              setDeleteReason(event.target.value);
            }}
            placeholder="Ex.: produto cadastrado incorretamente"
            value={deleteReason}
          />
        </label>
        {deleteError === null ? null : <p className="form-error">{deleteError}</p>}
        <div className="product-delete-options">
          <button
            className="button button--secondary"
            disabled={busy || deleteReason.trim().length < 3 || (impact?.openOrdersCount ?? 1) > 0}
            onClick={() => {
              setDeleteError(null);
              void onDelete({
                productId: product.id,
                mode: 'keep-sales-history',
                reason: deleteReason.trim(),
              }).catch((error: unknown) => {
                setDeleteError(
                  error instanceof Error ? error.message : 'Não foi possível excluir.',
                );
              });
            }}
            type="button"
          >
            Excluir e manter vendas no histórico
          </button>
          <button
            className="button button--danger"
            disabled={
              busy ||
              !hasActiveEvent ||
              deleteReason.trim().length < 3 ||
              (impact?.openOrdersCount ?? 1) > 0
            }
            onClick={() => {
              setDeleteError(null);
              void onDelete({
                productId: product.id,
                mode: 'refund-active-event-sales',
                reason: deleteReason.trim(),
              }).catch((error: unknown) => {
                setDeleteError(
                  error instanceof Error ? error.message : 'Não foi possível excluir.',
                );
              });
            }}
            type="button"
          >
            Estornar vendas deste evento e excluir
          </button>
          <button
            className="button button--ghost"
            disabled={busy}
            onClick={() => {
              setMode('view');
              setImpact(null);
              setDeleteReason('');
            }}
            type="button"
          >
            <X size={15} aria-hidden="true" />
            Cancelar
          </button>
        </div>
        <small>
          Manter histórico preserva nome, quantidade e preços vendidos. Se essa venda for estornada
          depois, o produto excluído não será recriado no estoque.
        </small>
      </article>
    );
  }

  return (
    <article
      className={
        product.active
          ? 'inventory-card inventory-card--compact'
          : 'inventory-card inventory-card--compact inventory-card--inactive'
      }
    >
      <div className="inventory-card__topline">
        <ProductVisual
          alt={product.name}
          fallbackIcon={product.fallbackIcon}
          imageDataUrl={product.imageDataUrl}
        />
        <div className="inventory-card__identity">
          <span>{product.categoryName}</span>
          <h2>{product.name}</h2>
          <small>{product.kind === 'drink' ? 'Bebida' : 'Comida'}</small>
        </div>
        <span className={product.lowStock ? 'stock-badge stock-badge--low' : 'stock-badge'}>
          {product.lowStock ? <TriangleAlert size={14} aria-hidden="true" /> : null}
          {product.quantity} un.
        </span>
        <span className="stock-badge stock-badge--sold">Vendido {product.soldQuantity} un.</span>
      </div>

      <div className="inventory-card__prices inventory-card__prices--compact">
        <div>
          <span>Venda</span>
          <strong>{formatMoney(product.salePriceCents)}</strong>
        </div>
        {product.financials === null ? null : (
          <>
            <div>
              <span>Custo médio</span>
              <strong>{formatMoney(product.financials.costCents)}</strong>
            </div>
            <div>
              <span>Valor do saldo</span>
              <strong>{formatMoney(product.financials.currentStockValueCents)}</strong>
            </div>
            <div>
              <span>Investido no evento</span>
              <strong>{formatMoney(product.financials.contributedCostCents)}</strong>
            </div>
            <div>
              <span>Receita se vender saldo</span>
              <strong>{formatMoney(product.financials.potentialGrossRevenueCents)}</strong>
            </div>
            <div>
              <span>Lucro se vender saldo</span>
              <strong>{formatMoney(product.financials.potentialGrossProfitCents)}</strong>
            </div>
          </>
        )}
      </div>

      <div className="inventory-card__footer">
        <span className="product-kind">
          <CircleDollarSign size={15} aria-hidden="true" />
          Margem{' '}
          {product.financials === null
            ? 'restrita'
            : `${product.financials.marginPercent.toFixed(2)}%`}
        </span>
        {!product.active ? (
          <span className="status-badge status-badge--archived">Inativo</span>
        ) : null}
        {production ? (
          <div className="inventory-card__actions">
            <button
              className="button button--ghost button--compact"
              disabled={busy}
              onClick={() => {
                setMode('edit');
              }}
              type="button"
            >
              <Pencil size={15} aria-hidden="true" />
              Editar
            </button>
            <button className="button button--ghost button--compact" disabled={busy || !hasActiveEvent} onClick={() => setMode('lots')} type="button">
              <ClipboardList size={15} aria-hidden="true" />Lotes
            </button>
            <button
              className="button button--secondary button--compact"
              disabled={busy || !hasActiveEvent}
              onClick={() => {
                setMode('entry');
              }}
              type="button"
            >
              <ArrowDownToLine size={15} aria-hidden="true" />
              Entrada
            </button>
            <button
              className="button button--secondary button--compact"
              disabled={busy || !hasActiveEvent || product.quantity === 0}
              onClick={() => {
                setMode('decrease');
              }}
              type="button"
            >
              <ArrowUpFromLine size={15} aria-hidden="true" />
              Baixar estoque · {product.quantity} un.
            </button>
            <button
              className="button button--ghost button--compact"
              disabled={busy}
              onClick={() => {
                setMode('delete');
                setDeleteError(null);
                setImpact(null);
                void onPreviewDeletion(product.id)
                  .then(setImpact)
                  .catch((error: unknown) => {
                    setDeleteError(
                      error instanceof Error
                        ? error.message
                        : 'Não foi possível calcular o impacto.',
                    );
                  });
              }}
              type="button"
            >
              <Trash2 size={15} aria-hidden="true" />
              Excluir
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
