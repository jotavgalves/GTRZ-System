import { useEffect, useState } from 'react';

import type { CloudMonitor, DesktopDevice, PrintStation } from '@gtrz/contracts';

import { useSession } from '../../shared/session/session-context';

interface Props {
  readonly devices: readonly DesktopDevice[];
  readonly monitor: CloudMonitor | null;
  readonly canConfigure: boolean;
}

export function PrintStationPanel({ devices, monitor, canConfigure }: Props): React.JSX.Element {
  const { state } = useSession();
  const eventId = state?.activeEvent?.id ?? null;
  const [station, setStation] = useState<PrintStation | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (eventId === null) {
      setStation(null);
      return;
    }
    let mounted = true;
    const refresh = (): void => {
      void window.gtrz.settings
        .getPrintStation(eventId)
        .then((value) => {
          if (!mounted) return;
          setStation(value);
          setChoice(value.deviceId ?? '');
          setError(null);
        })
        .catch((reason: unknown) => {
          if (mounted)
            setError(reason instanceof Error ? reason.message : 'Falha ao consultar a impressão.');
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [eventId]);

  const save = async (): Promise<void> => {
    if (eventId === null) return;
    setBusy(true);
    setError(null);
    try {
      setStation(await window.gtrz.settings.setPrintStation({ eventId, deviceId: choice || null }));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Falha ao escolher o PC.');
    } finally {
      setBusy(false);
    }
  };

  const chosen = station?.deviceId ?? null;
  const stationLabel = (id: string, label: string): string =>
    id === monitor?.localDeviceId ? 'Este PC' : label;
  const device = monitor?.activeDevices.find((item) => item.id === chosen);
  const printer = station?.printers.find((item) => item.deviceId === chosen && item.enabled);
  const present =
    device !== undefined &&
    Date.now() - device.lastSeenAt < 30_000 &&
    device.activeEventId === eventId;
  const printerReady =
    printer !== undefined && Date.now() - printer.lastSeenAt < 30_000 && printer.busyJobId === null;
  const ready = chosen !== null && present && printerReady;

  return (
    <section className="panel cloud-enrollment" aria-label="Estação de impressão">
      <div className="panel__heading">
        <div>
          <h2>PC responsável pela impressão</h2>
          <p>
            A nuvem entrega as notas somente ao PC escolhido para este evento. Sem ele, as notas
            aguardam na fila.
          </p>
        </div>
      </div>
      {eventId === null ? (
        <p>Selecione um evento para configurar a impressão.</p>
      ) : (
        <>
          <p>
            {chosen === null
              ? 'Nenhum PC escolhido. Nenhuma nota será impressa automaticamente.'
              : ready
                ? `Pronto: ${stationLabel(device.id, device.label)} · ${printer.printerName}`
                : `Atenção: ${stationLabel(chosen, device?.label ?? devices.find((item) => item.deviceId === chosen)?.label ?? 'PC escolhido')} está desconectado, fora deste evento ou sem impressora disponível.`}
          </p>
          <p>
            {station?.queued ?? 0} nota(s) aguardando · {station?.needsAttention ?? 0} exigem
            conferência.
          </p>
          {canConfigure ? (
            <div className="cloud-owner-actions">
              <label className="form-field">
                <span>Escolher computador</span>
                <select
                  value={choice}
                  onChange={(event) => {
                    setChoice(event.target.value);
                  }}
                >
                  <option value="">Nenhum PC</option>
                  {devices
                    .filter((item) => item.revokedAt === null)
                    .map((item) => (
                      <option key={item.deviceId} value={item.deviceId}>
                        {stationLabel(item.deviceId, item.label)}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="button button--primary"
                type="button"
                disabled={busy || choice === (chosen ?? '')}
                onClick={() => void save()}
              >
                Salvar estação
              </button>
            </div>
          ) : (
            <small>Entre como proprietário para escolher ou trocar o PC.</small>
          )}
        </>
      )}
      {error === null ? null : <p className="form-error">{error}</p>}
    </section>
  );
}
