import { Boxes, Pencil, Tags } from 'lucide-react';
import { useState } from 'react';

import type { InventoryCombo, InventoryProduct, UpdateComboInput } from '@gtrz/contracts';

import { ComboForm } from './ComboForm';

interface ComboCardProps {
  readonly combo: InventoryCombo;
  readonly products: readonly InventoryProduct[];
  readonly production: boolean;
  readonly busy: boolean;
  readonly onUpdate: (input: UpdateComboInput) => Promise<void>;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function ComboCard({
  combo,
  products,
  production,
  busy,
  onUpdate,
}: ComboCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const hasChoices = combo.components.some((component) => component.choiceGroup !== null);

  if (editing) {
    return (
      <article className="combo-card combo-card--expanded">
        <ComboForm
          busy={busy}
          combo={combo}
          onCancel={() => {
            setEditing(false);
          }}
          onSubmit={async (input) => {
            await onUpdate(input);
            setEditing(false);
          }}
          products={products}
        />
      </article>
    );
  }

  return (
    <article className={combo.active ? 'combo-card' : 'combo-card combo-card--inactive'}>
      <div className="combo-card__header">
        <div>
          <span>Combo · {combo.kind === 'food' ? 'Comida' : 'Bebida'}</span>
          <h3>{combo.name}</h3>
        </div>
        <span className="stock-badge">
          <Boxes size={14} aria-hidden="true" />
          {combo.availableUnits} disponíveis
        </span>
      </div>

      <div className="combo-card__prices">
        <div>
          <span>Preço do combo</span>
          <strong>{formatMoney(combo.salePriceCents)}</strong>
        </div>
        <div>
          <span>{hasChoices ? 'Venda individual máxima' : 'Venda individual'}</span>
          <strong>{formatMoney(combo.individualSaleTotalCents)}</strong>
        </div>
        <div>
          <span>{combo.savingsCents >= 0 ? 'Economia' : 'Acréscimo'}</span>
          <strong>{formatMoney(Math.abs(combo.savingsCents))}</strong>
        </div>
        {combo.financials === null ? null : (
          <>
            <div>
              <span>
                {combo.externalFoodTerms !== null
                  ? 'Valor do fornecedor'
                  : hasChoices
                    ? 'Custo máximo possível'
                    : 'Custo consolidado'}
              </span>
              <strong>{formatMoney(combo.financials.costCents)}</strong>
            </div>
            <div>
              <span>
                {combo.externalFoodTerms !== null
                  ? 'Comissão GTRZ'
                  : hasChoices
                    ? 'Lucro mínimo possível'
                    : 'Lucro bruto'}
              </span>
              <strong>{formatMoney(combo.financials.grossProfitCents)}</strong>
            </div>
            <div>
              <span>Margem</span>
              <strong>{combo.financials.marginPercent.toFixed(2)}%</strong>
            </div>
          </>
        )}
      </div>

      <div className="combo-card__components">
        {combo.components.map((component) => (
          <div key={`${component.choiceGroup ?? 'fixed'}-${component.productId}`}>
            <span>
              {component.choiceGroup === null
                ? component.productName
                : `${component.choiceLabel ?? 'Escolha'}: ${component.productName}`}
            </span>
            <strong>{component.quantity} un.</strong>
          </div>
        ))}
      </div>

      <div className="combo-card__footer">
        <span className="product-kind">
          <Tags size={15} aria-hidden="true" />
          {combo.components.length} componente{combo.components.length === 1 ? '' : 's'}
        </span>
        {!combo.active ? (
          <span className="status-badge status-badge--archived">Inativo</span>
        ) : null}
        {production ? (
          <button
            className="button button--ghost button--compact"
            disabled={busy}
            onClick={() => {
              setEditing(true);
            }}
            type="button"
          >
            <Pencil size={15} aria-hidden="true" />
            Editar combo
          </button>
        ) : null}
      </div>
    </article>
  );
}
