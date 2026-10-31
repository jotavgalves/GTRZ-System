import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import type { ForceWipeResult } from '@gtrz/contracts';

// The cloud and the main process check this phrase again; it is repeated here only to enable the button.
const CONFIRMATION_PHRASE = 'APAGAR TUDO';

interface ForceWipePanelProps {
  readonly eventId: string;
  readonly eventName: string;
  readonly onDone: () => Promise<void>;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function Counts({ result }: { readonly result: ForceWipeResult }): React.JSX.Element {
  const { cloud, local } = result;
  return (
    <ul>
      <li>
        Neste computador: {local.orders} pedidos ({local.paidOrders} pagos, {money(local.paidCents)}
        ), {local.tables} mesas, {local.cashMovements} movimentos de caixa, {local.expenses}{' '}
        despesas, {local.ticketSales} ingressos, {local.vouchers} vouchers e {local.stockMovements}{' '}
        movimentos de estoque.
      </li>
      <li>
        Na nuvem: {cloud.journal} registros do diário, {cloud.commands} comandos,{' '}
        {cloud.projections} projeções, {cloud.printJobs} notas na fila de impressão,{' '}
        {cloud.snapshots} cópias de segurança de sincronização e {cloud.pendingResets} pedido(s) de
        limpeza pendente(s).
      </li>
    </ul>
  );
}

/** Administrator-only forced wipe: it never waits for other computers and it deletes for real. */
export function ForceWipePanel({
  eventId,
  eventName,
  onDone,
}: ForceWipePanelProps): React.JSX.Element {
  const [confirmationName, setConfirmationName] = useState('');
  const [phrase, setPhrase] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ForceWipeResult | null>(null);
  const [done, setDone] = useState<ForceWipeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = confirmationName === eventName && reason.trim().length >= 3;

  const run = async (dryRun: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.gtrz.settings.forceWipeGlobalEvent({
        eventId,
        confirmationName,
        reason,
        dryRun,
        ...(dryRun ? {} : { confirmation: phrase }),
      });
      if (dryRun) {
        setPreview(result);
        setDone(null);
      } else {
        setDone(result);
        setPreview(null);
        setPhrase('');
        await onDone();
      }
    } catch (failure: unknown) {
      setError(
        failure instanceof Error ? failure.message : 'Não foi possível executar a limpeza forçada.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="cloud-event__reset">
      <summary>
        <ShieldAlert size={16} aria-hidden="true" />
        Limpeza forçada (administrador)
      </summary>
      <p>
        Apaga de verdade os dados deste evento na nuvem e neste computador, sem esperar os outros
        computadores. Os demais limpam ao receber o comando. Vendas, mesas, caixa, despesas,
        ingressos, vouchers, estoque e filas somem; o evento e o catálogo ficam. Não tem volta: pare
        as vendas nos celulares e nos PCs antes. Exige estar logado como proprietário da nuvem.
      </p>
      <label>
        <span>{`Digite ${eventName} para confirmar`}</span>
        <input
          value={confirmationName}
          onChange={(event) => {
            setConfirmationName(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <label>
        <span>Motivo da limpeza</span>
        <input
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <button
        className="button"
        disabled={busy || !ready}
        onClick={() => void run(true)}
        type="button"
      >
        Simular (não apaga nada)
      </button>
      {preview === null ? null : (
        <>
          <p>Isto é o que seria apagado:</p>
          <Counts result={preview} />
          <label>
            <span>{`Digite ${CONFIRMATION_PHRASE} para liberar o botão`}</span>
            <input
              value={phrase}
              onChange={(event) => {
                setPhrase(event.target.value);
              }}
            />
          </label>
          <button
            className="button button--danger"
            disabled={busy || phrase !== CONFIRMATION_PHRASE}
            onClick={() => void run(false)}
            type="button"
          >
            {busy ? 'Apagando...' : 'Apagar à força agora'}
          </button>
        </>
      )}
      {done === null ? null : (
        <>
          <p className="form-success">Limpeza concluída. Foi apagado:</p>
          <Counts result={done} />
        </>
      )}
      {error === null ? null : <p className="form-error">{error}</p>}
    </details>
  );
}
