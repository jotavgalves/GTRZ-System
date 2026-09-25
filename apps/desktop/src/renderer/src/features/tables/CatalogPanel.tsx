import { Minus, PackageSearch, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { ComboComponentSelection, OperationCatalogItem } from '@gtrz/contracts';

import { ProductVisual } from '../../shared/product/ProductVisual';

interface CatalogPanelProps {
  readonly items: readonly OperationCatalogItem[];
  readonly busy: boolean;
  readonly onAdd: (
    item: OperationCatalogItem,
    componentSelections?: readonly ComboComponentSelection[],
  ) => Promise<void>;
}

type CatalogFilter = 'all' | 'product' | 'drink' | 'food' | 'combo';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

export function CatalogPanel({ items, busy, onAdd }: CatalogPanelProps): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<CatalogFilter>('all');
  const [pendingChoiceItem, setPendingChoiceItem] = useState<OperationCatalogItem | null>(null);
  const [choiceQuantities, setChoiceQuantities] = useState<Record<string, number>>({});
  const filtered = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase('pt-BR');
    return items.filter(
      (item) =>
        (kind === 'all' ||
          (kind === 'product' && item.kind === 'product') ||
          (kind === 'drink' && item.kind === 'product' && item.category === 'drink') ||
          (kind === 'food' && item.category === 'food') ||
          (kind === 'combo' && item.kind === 'combo' && item.category === 'drink')) &&
        (normalized.length === 0 || item.name.toLocaleLowerCase('pt-BR').includes(normalized)),
    );
  }, [items, kind, search]);

  const beginAdd = (item: OperationCatalogItem): void => {
    if (item.choiceGroups.length === 0) {
      void onAdd(item);
      return;
    }
    setPendingChoiceItem(item);
    setChoiceQuantities({});
  };
  const updateChoice = (key: string, next: number): void => {
    setChoiceQuantities((current) => ({ ...current, [key]: Math.max(0, next) }));
  };
  const validChoices =
    pendingChoiceItem?.choiceGroups.every((group) => {
      const chosen = group.options.reduce(
        (total, option) => total + (choiceQuantities[`${group.id}:${option.productId}`] ?? 0),
        0,
      );
      return chosen === group.quantity;
    }) === true;

  return (
    <article className="panel operation-catalog">
      <div className="panel__heading">
        <PackageSearch size={20} aria-hidden="true" />
        <div>
          <h2>Produtos e combos</h2>
          <p>Os itens indisponíveis permanecem visíveis, mas não podem ser adicionados.</p>
        </div>
      </div>
      <div className="operation-catalog__filters">
        <label className="compact-field__input">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Buscar produto ou combo"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Buscar item"
            value={search}
          />
        </label>
        <select
          aria-label="Filtrar catálogo"
          onChange={(event) => {
            setKind(event.target.value as CatalogFilter);
          }}
          value={kind}
        >
          <option value="all">Todos</option>
          <option value="product">Produtos</option>
          <option value="drink">Bebidas</option>
          <option value="food">Comidas</option>
          <option value="combo">Combos de bebida</option>
        </select>
      </div>
      <div className="operation-catalog__list">
        {filtered.map((item) => {
          const available = item.active && item.availableQuantity > 0;
          return (
            <button
              className="catalog-item"
              disabled={busy || !available}
              key={`${item.kind}-${item.id}`}
              onClick={() => {
                beginAdd(item);
              }}
              type="button"
            >
              <ProductVisual
                alt={item.name}
                fallbackIcon={item.fallbackIcon}
                imageDataUrl={item.imageDataUrl}
                size="small"
              />
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.kind === 'combo'
                    ? item.category === 'food'
                      ? 'Combo de comida'
                      : 'Combo de bebida'
                    : item.category === 'food'
                      ? 'Comida'
                      : 'Bebida'}{' '}
                  · {item.availableQuantity} disponíveis
                </small>
              </span>
              <span className="catalog-item__price">{formatMoney(item.salePriceCents)}</span>
              <Plus size={17} aria-hidden="true" />
            </button>
          );
        })}
        {filtered.length === 0 ? <p className="operation-empty">Nenhum item encontrado.</p> : null}
      </div>
      {pendingChoiceItem === null ? null : (
        <div className="combo-choice-overlay">
          <div
            className="combo-choice-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Escolher componentes do combo"
          >
            <div className="combo-choice-dialog__header">
              <div>
                <span className="eyebrow">Monte o combo</span>
                <h3>{pendingChoiceItem.name}</h3>
                <p>As escolhas abaixo serão registradas na comanda e baixadas do estoque.</p>
              </div>
              <button
                aria-label="Fechar escolhas do combo"
                className="icon-button"
                disabled={busy}
                onClick={() => {
                  setPendingChoiceItem(null);
                }}
                type="button"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            {pendingChoiceItem.choiceGroups.map((group) => {
              const chosen = group.options.reduce(
                (total, option) =>
                  total + (choiceQuantities[`${group.id}:${option.productId}`] ?? 0),
                0,
              );
              return (
                <section className="combo-choice-dialog__group" key={group.id}>
                  <div>
                    <strong>{group.label}</strong>
                    <small>
                      Escolha {group.quantity} un. · selecionadas {chosen}
                    </small>
                  </div>
                  {group.options.map((option) => {
                    const key = `${group.id}:${option.productId}`;
                    const quantity = choiceQuantities[key] ?? 0;
                    const canIncrease =
                      quantity < option.availableQuantity && chosen < group.quantity;
                    return (
                      <div className="combo-choice-dialog__option" key={key}>
                        <span>{option.productName}</span>
                        <small>{option.availableQuantity} em estoque</small>
                        <div className="combo-choice-dialog__stepper">
                          <button
                            aria-label={`Remover ${option.productName}`}
                            className="icon-button"
                            disabled={busy || quantity === 0}
                            onClick={() => {
                              updateChoice(key, quantity - 1);
                            }}
                            type="button"
                          >
                            <Minus size={15} aria-hidden="true" />
                          </button>
                          <strong>{quantity}</strong>
                          <button
                            aria-label={`Adicionar ${option.productName}`}
                            className="icon-button"
                            disabled={busy || !canIncrease}
                            onClick={() => {
                              updateChoice(key, quantity + 1);
                            }}
                            type="button"
                          >
                            <Plus size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              );
            })}
            <div className="combo-choice-dialog__actions">
              <button
                className="button button--ghost"
                disabled={busy}
                onClick={() => {
                  setPendingChoiceItem(null);
                }}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="button button--primary"
                disabled={busy || !validChoices}
                onClick={() => {
                  const componentSelections = pendingChoiceItem.choiceGroups.flatMap((group) =>
                    group.options.flatMap((option) => {
                      const quantity = choiceQuantities[`${group.id}:${option.productId}`] ?? 0;
                      return quantity === 0
                        ? []
                        : [{ choiceGroup: group.id, productId: option.productId, quantity }];
                    }),
                  );
                  void onAdd(pendingChoiceItem, componentSelections).then(() => {
                    setPendingChoiceItem(null);
                  });
                }}
                type="button"
              >
                Adicionar à comanda
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
