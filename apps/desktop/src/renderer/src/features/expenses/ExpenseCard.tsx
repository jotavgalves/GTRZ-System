import { Ban, CreditCard, Pencil, Save, Settings2, Trash2, WalletCards } from 'lucide-react';
import { useEffect, useState } from 'react';

import type {
  Expense,
  PaymentMethod,
  RecordExpensePaymentInput,
  UpdateExpenseInput,
} from '@gtrz/contracts';

interface ExpenseCardProps {
  readonly expense: Expense;
  readonly busy: boolean;
  readonly onRecordPayment: (input: RecordExpensePaymentInput) => Promise<void>;
  readonly onUpdate: (input: UpdateExpenseInput) => Promise<void>;
  readonly onCancel: (expenseId: string, reason: string) => Promise<void>;
  readonly onDelete: (expenseId: string, reason: string) => Promise<void>;
}

const PAYMENT_LABELS = {
  cash: 'Dinheiro',
  pix: 'PIX',
  'credit-card': 'Crédito',
  'debit-card': 'Débito',
} as const;

const STATUS_LABELS = {
  open: 'Em aberto',
  partial: 'Parcial',
  paid: 'Paga',
};

const STATUS_CLASSES = {
  open: 'status-badge status-badge--open',
  partial: 'status-badge status-badge--selected',
  paid: 'status-badge status-badge--closed',
};

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

function formatMoneyInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function parseMoney(value: string): number {
  const amount = Number(value.trim().replace(',', '.'));
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

export function ExpenseCard({
  expense,
  busy,
  onRecordPayment,
  onUpdate,
  onCancel,
  onDelete,
}: ExpenseCardProps): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(expense.category);
  const [description, setDescription] = useState(expense.description);
  const [amount, setAmount] = useState(formatMoneyInput(expense.amountCents));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(expense.paymentMethod);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethodInput, setPaymentMethodInput] = useState<PaymentMethod>(expense.paymentMethod);
  const [note, setNote] = useState(expense.note ?? '');
  const parsedAmountCents = parseMoney(amount);

  useEffect(() => {
    setCategory(expense.category);
    setDescription(expense.description);
    setAmount(formatMoneyInput(expense.amountCents));
    setPaymentMethod(expense.paymentMethod);
    setPaymentMethodInput(expense.paymentMethod);
    setNote(expense.note ?? '');
  }, [
    expense.amountCents,
    expense.category,
    expense.description,
    expense.note,
    expense.paymentMethod,
  ]);

  return (
    <article className="expense-card expense-card--compact">
      <header className="expense-card__header">
        <span>
          <strong>{expense.description}</strong>
          <small>{expense.category}</small>
        </span>
        <span
          className={
            expense.status === 'cancelled'
              ? 'status-badge status-badge--archived'
              : STATUS_CLASSES[expense.paymentStatus]
          }
        >
          {expense.status === 'cancelled' ? 'Cancelada' : STATUS_LABELS[expense.paymentStatus]}
        </span>
      </header>

      <div className="expense-card__value">
        <strong>{formatMoney(expense.amountCents)}</strong>
        <span>
          {expense.paymentMethod === 'cash' ? (
            <WalletCards size={15} aria-hidden="true" />
          ) : (
            <CreditCard size={15} aria-hidden="true" />
          )}
          {PAYMENT_LABELS[expense.paymentMethod]}
        </span>
      </div>

      {expense.status === 'active' ? <p><strong>Pago:</strong> {formatMoney(expense.paidCents)} · <strong>Pendente:</strong> {formatMoney(expense.outstandingCents)}</p> : null}

      {expense.note === null ? null : <p>{expense.note}</p>}

      <button
        className="button button--ghost button--compact"
        disabled={busy}
        onClick={() => {
          setManaging((value) => !value);
        }}
        type="button"
      >
        <Settings2 size={15} aria-hidden="true" />
        Gerenciar
      </button>

      {managing ? (
        <div className="expense-manage-drawer">
          {expense.status === 'active' ? (
            <>
              <button
                className="button button--secondary button--compact"
                disabled={busy}
                onClick={() => {
                  setEditing((value) => !value);
                }}
                type="button"
              >
                <Pencil size={15} aria-hidden="true" />
                Editar despesa
              </button>

              {editing ? (
                <form
                  className="expense-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onUpdate({
                      expenseId: expense.id,
                      category: category.trim(),
                      description: description.trim(),
                      amountCents: parsedAmountCents,
                      paymentMethod,
                      paymentStatus: expense.paymentStatus,
                      ...(note.trim().length === 0 ? {} : { note: note.trim() }),
                    }).then(() => {
                      setEditing(false);
                    });
                  }}
                >
                  <div className="expense-form__row">
                    <label className="form-field">
                      <span>Categoria</span>
                      <input
                        disabled={busy}
                        maxLength={80}
                        onChange={(event) => {
                          setCategory(event.target.value);
                        }}
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
                        required
                        value={description}
                      />
                    </label>
                  </div>
                  <div className="expense-form__row">
                    <label className="form-field">
                      <span>Valor</span>
                      <input
                        disabled={busy}
                        inputMode="decimal"
                        onChange={(event) => {
                          setAmount(event.target.value);
                        }}
                        required
                        value={amount}
                      />
                    </label>
                    <p className="form-field__hint">A situação é calculada automaticamente pelos pagamentos.</p>
                  </div>
                  <label className="form-field">
                    <span>Forma de pagamento</span>
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
                    className="button button--primary button--compact"
                    disabled={
                      busy ||
                      category.trim().length < 2 ||
                      description.trim().length < 2 ||
                      parsedAmountCents <= 0
                    }
                    type="submit"
                  >
                    <Save size={15} aria-hidden="true" />
                    Salvar alterações
                  </button>
                </form>
              ) : (
                <form className="expense-edit-form" onSubmit={(event) => { event.preventDefault(); void onRecordPayment({ expenseId: expense.id, method: paymentMethodInput, amountCents: parseMoney(paymentAmount) }).then(() => setPaymentAmount('')); }}>
                  <div className="expense-form__row">
                    <label className="form-field"><span>Pagamento real</span><input disabled={busy} inputMode="decimal" onChange={(event) => setPaymentAmount(event.target.value)} placeholder="0,00" value={paymentAmount} /></label>
                    <label className="form-field"><span>Por</span><select disabled={busy} onChange={(event) => setPaymentMethodInput(event.target.value as PaymentMethod)} value={paymentMethodInput}>{Object.entries(PAYMENT_LABELS).map(([method, label]) => <option key={method} value={method}>{label}</option>)}</select></label>
                  </div>
                  <button className="button button--primary button--compact" disabled={busy || parseMoney(paymentAmount) <= 0 || parseMoney(paymentAmount) > expense.outstandingCents} type="submit"><CreditCard size={15} aria-hidden="true" /> Registrar pagamento</button>
                </form>
              )}
            </>
          ) : null}

          <label className="form-field">
            <span>Motivo para cancelar ou excluir</span>
            <input
              disabled={busy}
              maxLength={240}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              placeholder="Ex.: lançamento duplicado"
              value={reason}
            />
          </label>
          <div className="expense-manage-drawer__actions">
            {expense.status === 'active' ? (
              <button
                className="button button--ghost button--compact"
                disabled={busy || reason.trim().length < 3}
                onClick={() => {
                  void onCancel(expense.id, reason.trim()).then(() => {
                    setReason('');
                    setManaging(false);
                  });
                }}
                type="button"
              >
                <Ban size={15} aria-hidden="true" />
                Cancelar lançamento
              </button>
            ) : null}
            <button
              className="button button--danger button--compact"
              disabled={busy || reason.trim().length < 3}
              onClick={() => {
                void onDelete(expense.id, reason.trim()).then(() => {
                  setReason('');
                  setManaging(false);
                });
              }}
              type="button"
            >
              <Trash2 size={15} aria-hidden="true" />
              Excluir definitivamente
            </button>
          </div>
          <small>
            Cancelar retira a despesa do resultado. Excluir remove o lançamento e preserva somente o
            registro da exclusão na auditoria.
          </small>
        </div>
      ) : null}
    </article>
  );
}
