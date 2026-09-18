import { CookingPot, HandCoins, PackagePlus, RefreshCw, Store, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { FoodState, InventoryState } from '@gtrz/contracts';

import { useRealtimeReload } from '../../shared/realtime/useRealtimeReload';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function toCents(value: string): number {
  const parsed = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Informe um valor monetário válido.');
  return Math.round(parsed * 100);
}

export function FoodPage(): React.JSX.Element {
  const [state, setState] = useState<FoodState | null>(null);
  const [inventory, setInventory] = useState<InventoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supplier, setSupplier] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [name, setName] = useState('');
  const [supplierValue, setSupplierValue] = useState('');
  const [commissionValue, setCommissionValue] = useState('');
  const [initialQuantity, setInitialQuantity] = useState('');
  const [comboOnly, setComboOnly] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [food, stock] = await Promise.all([
        window.gtrz.food.getState(),
        window.gtrz.inventory.getState(),
      ]);
      setState(food);
      setInventory(stock);
      setCategoryId(
        (current) => current || stock.categories.find((category) => category.active)?.id || '',
      );
      setSupplierId((current) => current || food.suppliers.find((item) => item.active)?.id || '');
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível carregar Comida.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRealtimeReload(reload);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
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
  const categories = useMemo(
    () => inventory?.categories.filter((category) => category.active) ?? [],
    [inventory],
  );
  const foodProducts = useMemo(
    () => inventory?.products.filter((product) => product.kind === 'food') ?? [],
    [inventory],
  );
  const canCreateExternalItem =
    categoryId.length > 0 &&
    supplierId.length > 0 &&
    name.trim().length >= 2 &&
    Number(initialQuantity) > 0;

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Operação, cozinha e repasses</span>
          <h1>Comida</h1>
          <p>Controle quem fornece, o que sai da cozinha e o resultado de cada venda.</p>
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
                  <p>Defina uma única vez quem é dono financeiro da comida neste evento.</p>
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
              {mode === null ? (
                <p className="form-hint">Escolha o modelo antes de cadastrar alimentos.</p>
              ) : null}
              {mode === 'gtrz' ? (
                <p className="form-hint">
                  Cadastre alimentos no Estoque: custos, entradas e saídas entram diretamente no
                  resultado da GTRZ. Marque “Vendido apenas em combos” para ingredientes que não
                  aparecem no caixa.
                </p>
              ) : null}
              {mode === 'external' ? (
                <p className="form-hint">
                  Cada venda separa automaticamente o valor do parceiro da comissão GTRZ. Itens só
                  de combo continuam controlando quantidade, mas não aparecem como venda avulsa.
                </p>
              ) : null}
            </article>
            {mode === 'external' ? (
              <article className="panel form-panel">
                <div className="panel__heading">
                  <Store size={20} aria-hidden="true" />
                  <div>
                    <h2>Fornecedor</h2>
                    <p>Cadastre o parceiro antes de adicionar os pratos dele.</p>
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
                    <span>Nome do fornecedor</span>
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
                <div className="category-chips">
                  {state?.suppliers.map((item) => (
                    <span key={item.id}>{item.name}</span>
                  ))}
                </div>
              </article>
            ) : null}
          </div>
          {mode === 'external' ? (
            <article className="panel form-panel food-entry-panel">
              <div className="panel__heading">
                <PackagePlus size={20} aria-hidden="true" />
                <div>
                  <h2>Novo item de fornecedor</h2>
                  <p>O preço de venda é calculado como valor do fornecedor mais comissão GTRZ.</p>
                </div>
              </div>
              {categories.length === 0 ? (
                <p className="inventory-helper">
                  Crie uma categoria no Estoque antes de cadastrar comida.
                </p>
              ) : (
                <form
                  className="product-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await window.gtrz.food.createExternalItem({
                        categoryId,
                        supplierId,
                        name,
                        supplierUnitCents: toCents(supplierValue),
                        commissionUnitCents: toCents(commissionValue),
                        initialQuantity: Number(initialQuantity),
                        comboOnly,
                      });
                      setName('');
                      setSupplierValue('');
                      setCommissionValue('');
                      setInitialQuantity('');
                      setComboOnly(false);
                    });
                  }}
                >
                  <div className="product-form__grid">
                    <label className="form-field">
                      <span>Nome do prato</span>
                      <input
                        disabled={busy}
                        maxLength={100}
                        minLength={2}
                        onChange={(event) => setName(event.target.value)}
                        required
                        value={name}
                      />
                    </label>
                    <label className="form-field">
                      <span>Fornecedor</span>
                      <select
                        disabled={busy}
                        onChange={(event) => setSupplierId(event.target.value)}
                        required
                        value={supplierId}
                      >
                        <option value="">Selecione</option>
                        {state?.suppliers.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="form-field">
                      <span>Categoria</span>
                      <select
                        disabled={busy}
                        onChange={(event) => setCategoryId(event.target.value)}
                        required
                        value={categoryId}
                      >
                        <option value="">Selecione</option>
                        {categories.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="form-field">
                      <span>Quantidade recebida</span>
                      <input
                        disabled={busy}
                        min="1"
                        onChange={(event) => setInitialQuantity(event.target.value)}
                        required
                        step="1"
                        type="number"
                        value={initialQuantity}
                      />
                    </label>
                    <label className="form-field">
                      <span>Valor do fornecedor por un.</span>
                      <input
                        disabled={busy}
                        inputMode="decimal"
                        min="0"
                        onChange={(event) => setSupplierValue(event.target.value)}
                        placeholder="0,00"
                        required
                        step="0.01"
                        type="number"
                        value={supplierValue}
                      />
                    </label>
                    <label className="form-field">
                      <span>Comissão GTRZ por un.</span>
                      <input
                        disabled={busy}
                        inputMode="decimal"
                        min="0"
                        onChange={(event) => setCommissionValue(event.target.value)}
                        placeholder="0,00"
                        required
                        step="0.01"
                        type="number"
                        value={commissionValue}
                      />
                    </label>
                  </div>
                  <label className="checkbox-field">
                    <input
                      checked={comboOnly}
                      disabled={busy}
                      onChange={(event) => setComboOnly(event.target.checked)}
                      type="checkbox"
                    />
                    Vendido apenas em combos
                  </label>
                  <div className="food-price-preview">
                    <span>Preço de venda calculado</span>
                    <strong>
                      {formatMoney(
                        (Number(supplierValue.replace(',', '.')) || 0) * 100 +
                          (Number(commissionValue.replace(',', '.')) || 0) * 100,
                      )}
                    </strong>
                  </div>
                  <div className="product-form__actions">
                    <button
                      className="button button--primary"
                      disabled={busy || !canCreateExternalItem}
                      type="submit"
                    >
                      <HandCoins size={17} aria-hidden="true" />
                      Cadastrar e dar entrada
                    </button>
                  </div>
                </form>
              )}
            </article>
          ) : null}
          <article className="panel form-panel food-results-panel">
            <div className="panel__heading">
              <HandCoins size={20} aria-hidden="true" />
              <div>
                <h2>{mode === 'external' ? 'Vendas e repasses' : 'Itens de comida no estoque'}</h2>
                <p>
                  {mode === 'external'
                    ? 'Valores fechados somente de vendas pagas; cancelamentos são removidos automaticamente.'
                    : 'As receitas, custos e lucros dos itens próprios permanecem no Estoque e nas Visões gerais.'}
                </p>
              </div>
            </div>
            {mode === 'external' ? (
              <div className="food-result-list">
                {state?.items.length === 0 ? (
                  <p className="inventory-helper">
                    Nenhum item externo foi cadastrado neste evento.
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
                {foodProducts.length === 0 ? (
                  <p className="inventory-helper">
                    Ainda não há comida cadastrada. Cadastre no Estoque e controle custos por
                    entrada de lote.
                  </p>
                ) : (
                  foodProducts.map((product) => (
                    <article className="food-owned-row" key={product.id}>
                      <div>
                        <strong>{product.name}</strong>
                        <small>
                          {product.comboOnly ? 'Apenas em combos' : 'Disponível no caixa'}
                        </small>
                      </div>
                      <span>{product.quantity} em estoque</span>
                      <span>Vendido: {product.soldQuantity}</span>
                      <strong>{formatMoney(product.salePriceCents)}</strong>
                    </article>
                  ))
                )}
              </div>
            )}
          </article>
        </>
      )}
    </section>
  );
}
