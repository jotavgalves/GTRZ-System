import { ReceiptText } from 'lucide-react';
import { useState } from 'react';

import type { CreateExpenseInput, PaymentMethod } from '@gtrz/contracts';

interface ExpenseFormProps {
  readonly busy: boolean;
  readonly onSubmit: (input: CreateExpenseInput) => Promise<void>;
}

function parseMoney(value: string): number {
  const amount = Number(value.trim().replace(',', '.'));
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

const PAYMENT_LABELS: Readonly<Record<PaymentMethod, string>> = {
  cash: 'Dinheiro',
  pix: 'PIX',
  'credit-card': 'Crédito',
  'debit-card': 'Débito',
};

export function ExpenseForm({ busy, onSubmit }: ExpenseFormProps): React.JSX.Element {
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pix');
  const [note, setNote] = useState('');

  return (
    <form
      className="expense-form"
      onSubmit={(event) => {
        event.preventDefault();
        const normalizedNote = note.trim();
        const input: CreateExpenseInput = {
          category: category.trim(),
          description: description.trim(),
          amountCents: parseMoney(amount),
          paymentMethod,
          ...(normalizedNote.length === 0 ? {} : { note: normalizedNote }),
        };
        void onSubmit(input).then(() => {
          setDescription('');
          setAmount('');
          setNote('');
        });
      }}
    >
      <div className="panel__heading">
        <ReceiptText size={20} aria-hidden="true" />
        <div>
          <h2>Registrar despesa</h2>
          <p>O valor entra no resultado mesmo que a despesa ainda esteja em aberto.</p>
        </div>
      </div>
      <label className="form-field">
        <span>Categoria</span>
        <input
          disabled={busy}
          maxLength={80}
          onChange={(event) => {
            setCategory(event.target.value);
          }}
          placeholder="Ex.: Estrutura"
          required
          value={category}
        />
      </label>
      <label className="form-field">
        <span>Descrição</span>
        <input
          disabled={busy}
          maxLength={160}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
          placeholder="Ex.: Locação de gerador"
          required
          value={description}
        />
      </label>
      <div className="expense-form__row">
        <label className="form-field">
          <span>Valor da despesa</span>
          <input
            disabled={busy}
            inputMode="decimal"
            onChange={(event) => {
              setAmount(event.target.value);
            }}
            placeholder="0,00"
            required
            value={amount}
          />
        </label>
        <p className="form-field__hint">O pagamento é lançado separadamente. Assim, o caixa só muda quando o dinheiro realmente sai.</p>
      </div>
      <label className="form-field">
        <span>Forma prevista</span>
        <select
          disabled={busy}
          onChange={(event) => {
            setPaymentMethod(event.target.value as PaymentMethod);
          }}
          value={paymentMethod}
        >
          {Object.entries(PAYMENT_LABELS).map(([method, label]) => (
            <option key={method} value={method}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field">
        <span>Observação</span>
        <input
          disabled={busy}
          maxLength={240}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          placeholder="Opcional"
          value={note}
        />
      </label>
      <button
        className="button"
        disabled={
          busy ||
          category.trim().length < 2 ||
          description.trim().length < 2 ||
          parseMoney(amount) <= 0
        }
        type="submit"
      >
        Registrar despesa
      </button>
    </form>
  );
}
