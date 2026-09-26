import { ReceiptText, RefreshCw, TriangleAlert } from 'lucide-react';

import { ExpenseCard } from './ExpenseCard';
import { ExpenseForm } from './ExpenseForm';
import { useExpenses } from './useExpenses';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function ExpensesPage(): React.JSX.Element {
  const {
    state,
    loading,
    busy,
    error,
    message,
    reload,
    createExpense,
    updateExpense,
    recordPayment,
    cancelExpense,
    deleteExpense,
  } = useExpenses();
  if (loading && state === null) {
    return <div className="route-state">Carregando despesas…</div>;
  }
  const expenses = state?.expenses ?? [];
  const activeExpenses = expenses.filter((expense) => expense.status === 'active');
  const totalCents = activeExpenses.reduce((total, expense) => total + expense.amountCents, 0);
  const openCount = activeExpenses.filter((expense) => expense.paymentStatus === 'open').length;
  const partialCount = activeExpenses.filter(
    (expense) => expense.paymentStatus === 'partial',
  ).length;
  const paidCount = activeExpenses.filter((expense) => expense.paymentStatus === 'paid').length;

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Compromissos financeiros do evento</span>
          <h1>Despesas</h1>
          <p>
            Compromissos reduzem o resultado; somente pagamentos reais entram na conciliação física
            do caixa.
          </p>
        </div>
        <button
          className="button button--secondary"
          disabled={loading || busy}
          onClick={() => {
            void reload();
          }}
          type="button"
        >
          <RefreshCw size={17} aria-hidden="true" />
          Atualizar
        </button>
      </header>

      <div className="summary-grid summary-grid--compact">
        <article className="summary-card summary-card--accent">
          <span>Total de despesas</span>
          <strong>{formatMoney(totalCents)}</strong>
        </article>
        <article className="summary-card">
          <span>Em aberto</span>
          <strong>{openCount}</strong>
        </article>
        <article className="summary-card">
          <span>Parciais</span>
          <strong>{partialCount}</strong>
        </article>
        <article className="summary-card">
          <span>Pagas</span>
          <strong>{paidCount}</strong>
        </article>
      </div>

      {state?.activeEventId === null || state === null ? (
        <div className="inventory-warning">
          <TriangleAlert size={19} aria-hidden="true" />
          <span>Selecione um evento aberto antes de registrar despesas.</span>
        </div>
      ) : null}

      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}

      {state?.activeEventId !== null && state !== null ? (
        <div className="expense-layout">
          <article className="panel">
            <ExpenseForm busy={busy} onSubmit={createExpense} />
          </article>
          <div className="expense-list" aria-live="polite">
            {loading ? <div className="route-state">Carregando despesas…</div> : null}
            {!loading && expenses.length === 0 ? (
              <div className="empty-state">
                <ReceiptText size={32} aria-hidden="true" />
                <h2>Nenhuma despesa registrada</h2>
                <p>Cadastre o primeiro compromisso financeiro do evento.</p>
              </div>
            ) : null}
            {expenses.map((expense) => (
              <ExpenseCard
                busy={busy}
                expense={expense}
                key={expense.id}
                onCancel={cancelExpense}
                onDelete={deleteExpense}
                onRecordPayment={recordPayment}
                onUpdate={updateExpense}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
