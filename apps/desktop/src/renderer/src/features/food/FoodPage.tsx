import {
  Archive,
  CookingPot,
  HandCoins,
  Pencil,
  RefreshCw,
  Store,
  TriangleAlert,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FoodState, InventoryState } from '@gtrz/contracts';
import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

export function FoodPage(): React.JSX.Element {
  const [state, setState] = useState<FoodState | null>(null);
  const [inventory, setInventory] = useState<InventoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supplier, setSupplier] = useState('');
  const [editingSupplier, setEditingSupplier] = useState<string | null>(null);
  const [supplierDraft, setSupplierDraft] = useState('');
  const reload = useCallback(async () => {
    try {
      const [food, stock] = await Promise.all([
        window.gtrz.food.getState(),
        window.gtrz.inventory.getState(),
      ]);
      setState(food);
      setInventory(stock);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível carregar Comida.');
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useRealtimeReload(reload);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  };
  const mode = state?.supplierMode ?? null;
  const foodProducts = useMemo(
    () => inventory?.products.filter((product) => product.kind === 'food') ?? [],
    [inventory],
  );
  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Operação, cozinha e repasses</span>
          <h1>Comida</h1>
          <p>Fornecedores, vendas e repasses. Os itens são cadastrados no Estoque.</p>
        </div>
        <button
          className="button button--secondary"
          disabled={busy}
          onClick={() => void reload()}
          type="button"
        >
          <RefreshCw size={17} aria-hidden="true" />
          Atualizar
        </button>
      </header>
      {state?.activeEventId === null ? (
        <div className="inventory-warning">
          <TriangleAlert size={19} aria-hidden="true" />
          <span>Selecione um evento aberto antes de configurar Comida.</span>
        </div>
      ) : null}
      {error === null ? null : <p className="form-error">{error}</p>}
      {state?.activeEventId === null ? null : (
        <>
          <div className="summary-grid summary-grid--compact food-summary-grid">
            <article className="summary-card">
              <span>Itens vendidos</span>
              <strong>{state?.summary.soldQuantity ?? 0}</strong>
            </article>
            <article className="summary-card">
              <span>Total recebido</span>
              <strong>{formatMoney(state?.summary.receivedCents ?? 0)}</strong>
            </article>
            <article className="summary-card">
              <span>Repasse ao fornecedor</span>
              <strong>{formatMoney(state?.summary.supplierCents ?? 0)}</strong>
            </article>
            <article className="summary-card summary-card--accent">
              <span>Comissão GTRZ</span>
              <strong>{formatMoney(state?.summary.commissionCents ?? 0)}</strong>
            </article>
          </div>
          <div className="expense-layout food-layout">
            <article className="panel form-panel">
              <div className="panel__heading">
                <CookingPot size={20} aria-hidden="true" />
                <div>
                  <h2>Modelo do evento</h2>
                  <p>Define quem é dono financeiro da comida deste evento.</p>
                </div>
              </div>
              <div className="product-form__actions food-mode-actions">
                <button
                  className={
                    mode === 'gtrz' ? 'button button--primary' : 'button button--secondary'
                  }
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.gtrz.food.configure({ supplierMode: 'gtrz' }))
                  }
                  type="button"
                >
                  A GTRZ fornece
                </button>
                <button
                  className={
                    mode === 'external' ? 'button button--primary' : 'button button--secondary'
                  }
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.gtrz.food.configure({ supplierMode: 'external' }))
                  }
                  type="button"
                >
                  Fornecedor externo
                </button>
              </div>
              <p className="form-hint">
                Cadastre todos os produtos e dê entrada exclusivamente no Estoque. Use “Somente em
                combos” para ingredientes que não aparecem no caixa.
              </p>
            </article>
            {mode === 'external' ? (
              <article className="panel form-panel">
                <div className="panel__heading">
                  <Store size={20} aria-hidden="true" />
                  <div>
                    <h2>Fornecedores</h2>
                    <p>Parceiros que receberão o repasse das vendas.</p>
                  </div>
                </div>
                <form
                  className="finance-inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await window.gtrz.food.createSupplier({ name: supplier });
                      setSupplier('');
                    });
                  }}
                >
                  <label className="form-field">
                    <span>Nome</span>
                    <input
                      disabled={busy}
                      maxLength={100}
                      onChange={(event) => setSupplier(event.target.value)}
                      required
                      value={supplier}
                    />
                  </label>
                  <button
                    className="button button--secondary"
                    disabled={busy || supplier.trim().length < 2}
                    type="submit"
                  >
                    Adicionar
                  </button>
                </form>
                <div className="category-manager">
                  {state?.suppliers.map((item) =>
                    editingSupplier === item.id ? (
                      <form
                        className="category-manager__edit"
                        key={item.id}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void run(async () => {
                            await window.gtrz.food.updateSupplier({
                              supplierId: item.id,
                              name: supplierDraft,
                            });
                            setEditingSupplier(null);
                          });
                        }}
                      >
                        <input
                          autoFocus
                          onChange={(event) => setSupplierDraft(event.target.value)}
                          value={supplierDraft}
                        />
                        <button
                          className="button button--compact"
                          disabled={busy || supplierDraft.trim().length < 2}
                          type="submit"
                        >
                          Salvar
                        </button>
                      </form>
                    ) : (
                      <div className="category-manager__row" key={item.id}>
                        <span>
                          {item.name}
                          {item.active ? '' : ' (arquivado)'}
                        </span>
                        <button
                          className="icon-button"
                          disabled={busy}
                          onClick={() => {
                            setEditingSupplier(item.id);
                            setSupplierDraft(item.name);
                          }}
                          type="button"
                        >
                          <Pencil size={14} />
                        </button>
                        {item.active ? (
                          <>
                            <button
                              aria-label={`Arquivar ${item.name}`}
                              className="icon-button"
                              disabled={busy}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Arquivar ${item.name}? O histórico será preservado.`,
                                  )
                                )
                                  void run(() =>
                                    window.gtrz.food.archiveSupplier({ supplierId: item.id }),
                                  );
                              }}
                              type="button"
                            >
                              <Archive size={14} />
                            </button>
                            <button
                              aria-label={`Excluir ${item.name}`}
                              className="icon-button"
                              disabled={busy}
                              onClick={() => {
                                const reason = window.prompt(
                                  `Motivo para excluir ${item.name}. Se houver vendas, você poderá confirmar o estorno delas.`,
                                );
                                if (reason === null || reason.trim().length < 3) return;
                                void run(async () => {
                                  try {
                                    await window.gtrz.food.deleteSupplier({
                                      supplierId: item.id,
                                      deleteLinkedSales: false,
                                      reason,
                                    });
                                  } catch (deleteError) {
                                    const message =
                                      deleteError instanceof Error ? deleteError.message : 'Não foi possível excluir.';
                                    if (!message.includes('Confirme a exclusão das vendas')) throw deleteError;
                                    if (
                                      !window.confirm(
                                        `${message}\n\nExcluir também essas vendas, com os respectivos estornos?`,
                                      )
                                    )
                                      return;
                                    await window.gtrz.food.deleteSupplier({
                                      supplierId: item.id,
                                      deleteLinkedSales: true,
                                      reason,
                                    });
                                  }
                                });
                              }}
                              type="button"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        ) : null}
                      </div>
                    ),
                  )}
                </div>
              </article>
            ) : null}
          </div>
          <article className="panel form-panel food-results-panel">
            <div className="panel__heading">
              <HandCoins size={20} aria-hidden="true" />
              <div>
                <h2>{mode === 'external' ? 'Vendas e repasses' : 'Itens de comida no estoque'}</h2>
                <p>
                  {mode === 'external'
                    ? 'Vendas pagas, valores de parceiro e comissão GTRZ.'
                    : 'Custos, entradas e resultados permanecem no Estoque e Visão geral.'}
                </p>
              </div>
            </div>
            {mode === 'external' ? (
              <div className="food-result-list">
                {state?.items.length === 0 ? (
                  <p className="inventory-helper">
                    Cadastre as comidas pelo Estoque e vincule seus termos de fornecedor antes da
                    venda.
                  </p>
                ) : (
                  state?.items.map((item) => (
                    <article className="food-result-row" key={item.productId}>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.supplierName}</small>
                      </div>
                      <span>{item.soldQuantity} vendidas</span>
                      <span>
                        <small>Recebido</small>
                        {formatMoney(item.receivedCents)}
                      </span>
                      <span>
                        <small>Fornecedor</small>
                        {formatMoney(item.supplierCents)}
                      </span>
                      <span className="food-result-row__commission">
                        <small>GTRZ</small>
                        {formatMoney(item.commissionCents)}
                      </span>
                    </article>
                  ))
                )}
              </div>
            ) : (
              <div className="food-owned-list">
                {foodProducts.map((product) => (
                  <article className="food-owned-row" key={product.id}>
                    <div>
                      <strong>{product.name}</strong>
                      <small>
                        {product.comboOnly ? 'Somente em combos' : 'Disponível no caixa'}
                      </small>
                    </div>
                    <span>{product.quantity} em estoque</span>
                    <span>Vendido: {product.soldQuantity}</span>
                    <strong>{formatMoney(product.salePriceCents)}</strong>
                  </article>
                ))}
              </div>
            )}
          </article>
        </>
      )}
    </section>
  );
}
