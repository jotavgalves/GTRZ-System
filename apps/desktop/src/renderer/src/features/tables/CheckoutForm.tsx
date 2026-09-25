import { useEffect, useMemo, useState } from 'react';

import type { CloseOrderInput, Order, PaymentMethod } from '@gtrz/contracts';

import {
  formatMoney,
  formatMoneyInput,
  newPayment,
  parseMoney,
  type PaymentDraft,
} from './checkout-payment-utils';
import { MixedPaymentPanel } from './MixedPaymentPanel';
import { SimplePaymentPanel } from './SimplePaymentPanel';
import { VoucherCheckout } from './VoucherCheckout';

interface CheckoutFormProps {
  readonly order: Order;
  readonly busy: boolean;
  readonly onBindVoucher: (code: string) => Promise<void>;
  readonly onUnbindVoucher: () => Promise<void>;
  readonly onClose: (input: Omit<CloseOrderInput, 'orderId'>) => Promise<void>;
}

type CheckoutMode = 'simple' | 'mixed';

export function CheckoutForm({
  order,
  busy,
  onBindVoucher,
  onUnbindVoucher,
  onClose,
}: CheckoutFormProps): React.JSX.Element {
  const [mode, setMode] = useState<CheckoutMode>('simple');
  const [simpleMethod, setSimpleMethod] = useState<PaymentMethod>('cash');
  const [simpleReceived, setSimpleReceived] = useState('');
  const [payments, setPayments] = useState<readonly PaymentDraft[]>([newPayment()]);
  const [voucherAmount, setVoucherAmount] = useState('');
  const totalCents = order.subtotalCents;
  const allocation = order.voucherAllocation;
  const voucherCents = parseMoney(voucherAmount);
  const remainingAfterVoucherCents = Math.max(totalCents - voucherCents, 0);

  useEffect(() => {
    if (allocation === null) {
      setVoucherAmount('');
      return;
    }

    setVoucherAmount((current) => {
      const currentCents = parseMoney(current);
      const maximumCents = Math.min(allocation.remainingBalanceCents, totalCents);

      if (currentCents > 0 && currentCents <= maximumCents) return current;
      return maximumCents > 0 ? formatMoneyInput(maximumCents) : '';
    });
  }, [allocation, totalCents]);

  const mixedPaymentCents = useMemo(
    () => payments.reduce((total, payment) => total + parseMoney(payment.amount), 0),
    [payments],
  );
  const mixedInformedCents = mixedPaymentCents + voucherCents;
  const simpleReceivedCents = parseMoney(simpleReceived);
  const simpleCashInvalid =
    simpleMethod === 'cash' &&
    simpleReceivedCents > 0 &&
    simpleReceivedCents < remainingAfterVoucherCents;
  const mixedCashInvalid = payments.some((payment) => {
    if (payment.method !== 'cash') return false;
    const amountCents = parseMoney(payment.amount);
    const receivedCents = parseMoney(payment.received);
    return receivedCents > 0 && receivedCents < amountCents;
  });
  const voucherInvalid =
    voucherCents > 0 &&
    (allocation?.status !== 'active' ||
      voucherCents > allocation.remainingBalanceCents ||
      voucherCents > totalCents);
  const simpleChangeCents =
    simpleMethod === 'cash' ? Math.max(simpleReceivedCents - remainingAfterVoucherCents, 0) : 0;
  const mixedChangeCents = useMemo(
    () =>
      payments.reduce((total, payment) => {
        if (payment.method !== 'cash') return total;
        return total + Math.max(parseMoney(payment.received) - parseMoney(payment.amount), 0);
      }, 0),
    [payments],
  );
  const totalChangeCents = mode === 'simple' ? simpleChangeCents : mixedChangeCents;
  const canSubmit =
    !busy &&
    !voucherInvalid &&
    totalCents > 0 &&
    (mode === 'simple'
      ? !simpleCashInvalid
      : !mixedCashInvalid && mixedInformedCents === totalCents);

  const updatePayment = (id: string, patch: Partial<PaymentDraft>): void => {
    setPayments((current) =>
      current.map((payment) => (payment.id === id ? { ...payment, ...patch } : payment)),
    );
  };

  const submitCheckout = (): void => {
    if (!canSubmit) return;

    const normalizedPayments =
      mode === 'simple'
        ? remainingAfterVoucherCents === 0
          ? []
          : simpleMethod === 'cash' && simpleReceivedCents > 0
            ? [
                {
                  method: simpleMethod,
                  amountCents: remainingAfterVoucherCents,
                  receivedCents: simpleReceivedCents,
                },
              ]
            : [{ method: simpleMethod, amountCents: remainingAfterVoucherCents }]
        : payments
            .map((payment) => {
              const amountCents = parseMoney(payment.amount);
              const receivedCents = parseMoney(payment.received);
              return payment.method === 'cash' && receivedCents > 0
                ? { method: payment.method, amountCents, receivedCents }
                : { method: payment.method, amountCents };
            })
            .filter((payment) => payment.amountCents > 0);
    const voucherUses =
      allocation !== null && voucherCents > 0
        ? [{ code: allocation.code, amountCents: voucherCents }]
        : [];

    void onClose({ discountCents: 0, payments: normalizedPayments, voucherUses });
  };

  return (
    <form
      className="checkout-form"
      onSubmit={(event) => {
        event.preventDefault();
        submitCheckout();
      }}
    >
      <VoucherCheckout
        allocation={allocation}
        busy={busy}
        invalid={voucherInvalid}
        onBind={onBindVoucher}
        onUnbind={onUnbindVoucher}
        onValueChange={setVoucherAmount}
        orderId={order.id}
        value={voucherAmount}
        valueCents={voucherCents}
      />

      <div className="checkout-mode-switch">
        <button
          className={mode === 'simple' ? 'button button--primary' : 'button button--secondary'}
          disabled={busy}
          onClick={() => {
            setMode('simple');
          }}
          type="button"
        >
          Pagamento simples
        </button>
        <button
          className={mode === 'mixed' ? 'button button--primary' : 'button button--secondary'}
          disabled={busy}
          onClick={() => {
            setMode('mixed');
          }}
          type="button"
        >
          Pagamento misto
        </button>
      </div>

      {mode === 'simple' ? (
        <SimplePaymentPanel
          amountCents={remainingAfterVoucherCents}
          busy={busy}
          cashInvalid={simpleCashInvalid}
          method={simpleMethod}
          onMethodChange={(method) => {
            setSimpleMethod(method);
            setSimpleReceived('');
          }}
          onReceivedChange={setSimpleReceived}
          received={simpleReceived}
        />
      ) : (
        <MixedPaymentPanel
          busy={busy}
          onAdd={() => {
            setPayments((current) => [...current, newPayment('pix')]);
          }}
          onRemove={(id) => {
            setPayments((current) => current.filter((payment) => payment.id !== id));
          }}
          onUpdate={updatePayment}
          payments={payments}
        />
      )}

      {totalChangeCents > 0 ? (
        <div className="checkout-change" role="status">
          <span>Troco a entregar</span>
          <strong>{formatMoney(totalChangeCents)}</strong>
        </div>
      ) : null}

      <div className="checkout-form__actions checkout-form__actions--finish">
        <button className="button button--checkout" disabled={!canSubmit} type="submit">
          Concluir venda
        </button>
      </div>
    </form>
  );
}
