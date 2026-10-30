import { CreditCard, RefreshCw, TriangleAlert, WalletCards } from 'lucide-react';

import { CashControls } from './CashControls';
import { useCash } from './useCash';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

const MOVEMENT_LABELS = {
  opening: 'Abertura',
  supply: 'Suprimento',
  withdrawal: 'Retirada',
} as const;

export function CashPage(): React.JSX.Element {
  const {
    state,
    loading,
    busy,
    error,
    message,
    reload,
    openRegister,
    recordMovement,
    closeRegister,
  } = useCash();
  if (loading && state === null) {
    return <div className="route-state">Carregando caixa…</div>;
  }
  const registerStatus =
    state?.register === null || state === null ? 'not-opened' : state.register.status;
  const sales = state?.salesByMethod;

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Conciliação derivada das operações</span>
          <h1>Caixa administrativo</h1>
          <p>
            Resultado = faturamento − despesas registradas − custo do estoque − taxas da maquininha.
            Pagamentos e reembolsos mudam o caixa somente quando são lançados.
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
        <article className="summary-card">
          <span>Faturamento bruto</span>
          <strong>{formatMoney(state?.grossSalesCents ?? 0)}</strong>
        </article>
        <article className="summary-card">
          <span>Despesas registradas</span>
          <strong>{formatMoney(state?.activeExpensesCents ?? 0)}</strong>
        </article>
        <article className="summary-card">
          <span>Despesas pendentes</span>
          <strong>{formatMoney(state?.outstandingExpensesCents ?? 0)}</strong>
        </article>
        <article className="summary-card">
          <span>A recuperar em aportes</span>
          <strong>{formatMoney(state?.recoverableCapitalCents ?? 0)}</strong>
        </article>
        <article className="summary-card">
          <span>Custo do estoque</span>
          <strong>{formatMoney(state?.stockCostCents ?? 0)}</strong>
        </article>
        <article className="summary-card">
          <span>Taxas da maquininha</span>
          <strong>{formatMoney(state?.terminalFeesCents ?? 0)}</strong>
        </article>
        <article className="summary-card summary-card--accent">
          <span>Caixa físico esperado</span>
          <strong>{formatMoney(state?.expectedCashCents ?? 0)}</strong>
        </article>
        <article
          className={
            (state?.projectedResultCents ?? 0) < 0
              ? 'summary-card summary-card--danger'
              : 'summary-card'
          }
        >
          <span>Resultado projetado</span>
          <strong>{formatMoney(state?.projectedResultCents ?? 0)}</strong>
        </article>
      </div>

      {state?.activeEventId === null || state === null ? (
        <div className="inventory-warning">
          <TriangleAlert size={19} aria-hidden="true" />
          <span>Selecione um evento aberto antes de administrar o caixa.</span>
        </div>
      ) : null}

      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}

      {state?.activeEventId !== null && state !== null ? (
        <>
          <CashControls
            busy={busy}
            onClose={closeRegister}
            onMovement={recordMovement}
            onOpen={openRegister}
            status={registerStatus}
          />

          <div className="finance-breakdown-grid">
            <article className="panel finance-breakdown">
              <div className="panel__heading">
                <CreditCard size={20} aria-hidden="true" />
                <div>
                  <h2>Vendas por meio</h2>
                  <p>Vouchers são exibidos separadamente e não duplicam receita.</p>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Dinheiro</dt>
                  <dd>{formatMoney(sales?.cashCents ?? 0)}</dd>
                </div>
                <div>
                  <dt>PIX</dt>
                  <dd>{formatMoney(sales?.pixCents ?? 0)}</dd>
                </div>
                <div>
                  <dt>Crédito</dt>
                  <dd>{formatMoney(sales?.creditCardCents ?? 0)}</dd>
                </div>
                <div>
                  <dt>Débito</dt>
                  <dd>{formatMoney(sales?.debitCardCents ?? 0)}</dd>
                </div>
                <div>
                  <dt>Vouchers</dt>
                  <dd>{formatMoney(sales?.voucherCents ?? 0)}</dd>
                </div>
              </dl>
            </article>

            <article className="panel finance-breakdown">
              <div className="panel__heading">
                <WalletCards size={20} aria-hidden="true" />
                <div>
                  <h2>Conferência</h2>
                  <p>
                    A situação em aberto, parcial ou paga é controle interno e não muda o resultado.
                  </p>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Abertura</dt>
                  <dd>{formatMoney(state.register?.openingCashCents ?? 0)}</dd>
                </div>
                <div>
                  <dt>Despesas pagas em dinheiro</dt>
                  <dd>{formatMoney(state.cashExpensesCents)}</dd>
                </div>
                <div>
                  <dt>Reembolsos em dinheiro</dt>
                  <dd>{formatMoney(state.cashCapitalReimbursementsCents)}</dd>
                </div>
                <div>
                  <dt>Devoluções em dinheiro</dt>
                  <dd>{formatMoney(state.cashRefundsCents)}</dd>
                </div>
                <div>
                  <dt>Custo aportado no estoque</dt>
                  <dd>{formatMoney(state.stockCostCents)}</dd>
                </div>
                <div>
                  <dt>Taxas da maquininha</dt>
                  <dd>{formatMoney(state.terminalFeesCents)}</dd>
                </div>
                <div>
                  <dt>Contado</dt>
                  <dd>
                    {state.register?.countedCashCents === null || state.register === null
                      ? 'Pendente'
                      : formatMoney(state.register.countedCashCents)}
                  </dd>
                </div>
                <div>
                  <dt>Diferença</dt>
                  <dd>
                    {state.register?.varianceCents === null || state.register === null
                      ? 'Pendente'
                      : formatMoney(state.register.varianceCents)}
                  </dd>
                </div>
              </dl>
            </article>
          </div>

          <article className="panel cash-movement-history">
            <div className="panel__heading">
              <WalletCards size={20} aria-hidden="true" />
              <div>
                <h2>Movimentações físicas</h2>
                <p>Abertura, suprimentos e retiradas do caixa.</p>
              </div>
            </div>
            {state.movements.length === 0 ? (
              <p className="operation-empty">Nenhuma movimentação registrada.</p>
            ) : (
              <div className="cash-movement-list">
                {state.movements.map((movement) => (
                  <div className="cash-movement-row" key={movement.id}>
                    <span>{MOVEMENT_LABELS[movement.type]}</span>
                    <strong>{formatMoney(movement.amountCents)}</strong>
                    <small>{movement.note ?? 'Sem observação'}</small>
                  </div>
                ))}
              </div>
            )}
          </article>
        </>
      ) : null}
    </section>
  );
}
