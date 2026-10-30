import { ArrowDownToLine, ArrowUpFromLine, X } from 'lucide-react';
import { useMemo, useState, type SyntheticEvent } from 'react';

import type {
  InventoryProduct,
  RecordStockMovementInput,
  StockMovementType,
} from '@gtrz/contracts';

function parseMoney(value: string): number {
  const amount = Number(value.trim().replace(',', '.'));
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

interface StockMovementFormProps {
  readonly product: InventoryProduct;
  readonly intent: 'entry' | 'decrease';
  readonly busy: boolean;
  readonly onSubmit: (input: RecordStockMovementInput) => Promise<void>;
  readonly onCancel: () => void;
}

const ENTRY_MOVEMENTS: readonly { readonly value: StockMovementType; readonly label: string }[] = [
  { value: 'purchase', label: 'Compra / entrada' },
  { value: 'correction-positive', label: 'Correção positiva' },
  { value: 'return', label: 'Devolução ao estoque' },
];
const DECREASE_MOVEMENTS: readonly { readonly value: StockMovementType; readonly label: string }[] =
  [
    { value: 'correction-negative', label: 'Correção negativa' },
    { value: 'loss', label: 'Perda' },
    { value: 'breakage', label: 'Quebra' },
    { value: 'internal-consumption', label: 'Consumo interno' },
    { value: 'courtesy', label: 'Cortesia' },
  ];

export function StockMovementForm({
  product,
  intent,
  busy,
  onSubmit,
  onCancel,
}: StockMovementFormProps): React.JSX.Element {
  const movements = intent === 'entry' ? ENTRY_MOVEMENTS : DECREASE_MOVEMENTS;
  const [type, setType] = useState<StockMovementType>(movements[0]?.value ?? 'purchase');
  const [quantity, setQuantity] = useState('1');
  const [purchaseTotal, setPurchaseTotal] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const parsedQuantity = Number(quantity);
  const nextQuantity = useMemo(() => {
    if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) return product.quantity;
    return intent === 'entry'
      ? product.quantity + parsedQuantity
      : product.quantity - parsedQuantity;
  }, [intent, parsedQuantity, product.quantity]);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      if (!Number.isInteger(parsedQuantity) || parsedQuantity <= 0) {
        throw new Error('A quantidade deve ser um número inteiro maior que zero.');
      }
      if (intent === 'decrease' && parsedQuantity > product.quantity) {
        throw new Error(
          `A baixa não pode ultrapassar o saldo atual de ${String(product.quantity)} unidades.`,
        );
      }
      const purchaseTotalCents = parseMoney(purchaseTotal);
      if (type === 'purchase' && purchaseTotalCents <= 0) {
        throw new Error('Informe o valor total pago nesta compra.');
      }
      const input: RecordStockMovementInput = {
        productId: product.id,
        type,
        quantity: parsedQuantity,
        ...(type === 'purchase' ? { purchaseTotalCents } : {}),
        ...(note.trim().length === 0 ? {} : { note: note.trim() }),
      };
      await onSubmit(input);
      onCancel();
    } catch (submitError: unknown) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Não foi possível movimentar o estoque.',
      );
    }
  }

  return (
    <form className="movement-form" onSubmit={(event) => void handleSubmit(event)}>
      <div className="movement-form__heading">
        <div>
          <span>{intent === 'entry' ? 'Entrada de estoque' : 'Baixar estoque'}</span>
          <strong>{product.name}</strong>
        </div>
        <span className="stock-number">Saldo atual: {product.quantity} un.</span>
      </div>
      <div className="movement-balance-preview">
        <span>Depois deste movimento</span>
        <strong className={nextQuantity < 0 ? 'text-danger' : undefined}>
          {Math.max(nextQuantity, 0)} un.
        </strong>
      </div>
      <div className="movement-form__grid">
        <label className="form-field">
          <span>Motivo</span>
          <select
            onChange={(event) => {
              setType(event.target.value as StockMovementType);
            }}
            value={type}
          >
            {movements.map((movement) => (
              <option key={movement.value} value={movement.value}>
                {movement.label}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Quantidade</span>
          <input
            max={intent === 'decrease' ? product.quantity : undefined}
            min="1"
            onChange={(event) => {
              setQuantity(event.target.value);
            }}
            required
            step="1"
            type="number"
            value={quantity}
          />
        </label>
        {type === 'purchase' ? (
          <label className="form-field">
            <span>Valor total pago</span>
            <input
              inputMode="decimal"
              onChange={(event) => {
                setPurchaseTotal(event.target.value);
              }}
              placeholder="0,00"
              required
              value={purchaseTotal}
            />
          </label>
        ) : null}
      </div>
      {type === 'purchase' &&
      Number.isInteger(parsedQuantity) &&
      parsedQuantity > 0 &&
      parseMoney(purchaseTotal) > 0 ? (
        <p className="form-hint">
          Lote criado automaticamente: {formatMoney(parseMoney(purchaseTotal) / parsedQuantity)} por
          unidade.
        </p>
      ) : null}
      {type === 'correction-negative' ? (
        <p className="form-hint">
          Correção negativa desfaz uma entrada lançada a maior e também reduz o aporte líquido
          calculado do produto.
        </p>
      ) : null}
      {type === 'loss' || type === 'breakage' ? (
        <p className="form-hint">
          Perda e quebra reduzem o valor que ainda existe no estoque, mas preservam o custo que
          realmente foi desembolsado.
        </p>
      ) : null}
      <label className="form-field">
        <span>Observação</span>
        <input
          maxLength={240}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          placeholder="Opcional"
          value={note}
        />
      </label>
      {error === null ? null : <p className="form-error">{error}</p>}
      <div className="product-form__actions">
        <button className="button button--ghost" disabled={busy} onClick={onCancel} type="button">
          <X size={16} aria-hidden="true" />
          Cancelar
        </button>
        <button
          className="button button--primary"
          disabled={busy || (intent === 'decrease' && product.quantity === 0)}
          type="submit"
        >
          {intent === 'entry' ? (
            <ArrowDownToLine size={17} aria-hidden="true" />
          ) : (
            <ArrowUpFromLine size={17} aria-hidden="true" />
          )}
          {intent === 'entry' ? 'Registrar entrada' : 'Confirmar baixa'}
        </button>
      </div>
    </form>
  );
}
