import { Boxes, Pencil, Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type {
  DeleteComboInput,
  InventoryCombo,
  InventoryProduct,
  UpdateComboInput,
} from '@gtrz/contracts';

import { ProductVisual } from '../../shared/product/ProductVisual';
import { ComboForm } from './ComboForm';

interface ComboCardProps {
  readonly combo: InventoryCombo;
  readonly products: readonly InventoryProduct[];
  readonly production: boolean;
  readonly busy: boolean;
  readonly onUpdate: (input: UpdateComboInput) => Promise<void>;
  readonly onDelete: (input: DeleteComboInput) => Promise<void>;
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
  onDelete,
}: ComboCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
        <ProductVisual
          alt={combo.name}
          fallbackIcon={combo.fallbackIcon}
          imageDataUrl={combo.imageDataUrl}
          size="small"
        />
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
        {production ? (
          <button
            className="button button--ghost button--compact"
            disabled={busy}
            onClick={() => {
              setDeleteError(null);
              setDeleting(true);
            }}
            type="button"
          >
            <Trash2 size={15} aria-hidden="true" />
            Excluir combo
          </button>
        ) : null}
      </div>

      {deleting ? (
        <form
          className="combo-delete-panel"
          onSubmit={(event) => {
            event.preventDefault();
            setDeleteError(null);
            onDelete({ comboId: combo.id, reason: reason.trim() })
              .then(() => {
                setDeleting(false);
                setReason('');
              })
              .catch((error: unknown) => {
                setDeleteError(
                  error instanceof Error ? error.message : 'Não foi possível excluir o combo.',
                );
              });
          }}
        >
          <label className="form-field">
            <span>Motivo da exclusão de “{combo.name}”</span>
            <input
              maxLength={200}
              minLength={3}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              placeholder="Ex.: combo antigo, não vendemos mais"
              required
              value={reason}
            />
          </label>
          {deleteError === null ? null : <p className="form-error">{deleteError}</p>}
          <div className="product-form__actions">
            <button
              className="button button--ghost button--compact"
              disabled={busy}
              onClick={() => {
                setDeleting(false);
              }}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="button button--danger button--compact"
              disabled={busy || reason.trim().length < 3}
              type="submit"
            >
              <Trash2 size={15} aria-hidden="true" />
              Confirmar exclusão
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
