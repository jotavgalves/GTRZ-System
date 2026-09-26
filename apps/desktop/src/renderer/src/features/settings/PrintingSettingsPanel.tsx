import { Printer, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';

import type { PrinterInfo, PrintingSettings, ThermalPaperWidth } from '@gtrz/contracts';

const DEFAULT_SETTINGS: PrintingSettings = {
  automaticPrinting: false,
  deviceName: null,
  machineName: '',
  paperWidthMm: 80,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível carregar a impressão térmica.';
}

export function PrintingSettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<PrintingSettings>(DEFAULT_SETTINGS);
  const [printers, setPrinters] = useState<readonly PrinterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [nextSettings, nextPrinters] = await Promise.all([
        window.gtrz.printing.getSettings(),
        window.gtrz.printing.listPrinters(),
      ]);
      setSettings(nextSettings);
      setPrinters(nextPrinters);
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await window.gtrz.printing.updateSettings(settings);
      setSettings(saved);
      setMessage('Configuração da impressora térmica salva.');
    } catch (submitError: unknown) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedPrinterExists =
    settings.deviceName === null ||
    printers.some((printer) => printer.name === settings.deviceName);

  return (
    <form className="panel form-panel" onSubmit={(event) => void handleSubmit(event)}>
      <div className="panel__heading">
        <Printer size={20} aria-hidden="true" />
        <div>
          <h2>Impressora térmica</h2>
          <p>A nota é enviada depois que a venda já foi concluída no banco.</p>
        </div>
      </div>

      <label className="checkbox-field">
        <input
          checked={settings.automaticPrinting}
          disabled={loading}
          onChange={(event) => {
            setSettings((current) => ({
              ...current,
              automaticPrinting: event.target.checked,
            }));
          }}
          type="checkbox"
        />
        Imprimir automaticamente após concluir a venda
      </label>

      <label className="form-field">
        <span>Nome deste computador na nuvem</span>
        <input
          disabled={loading}
          maxLength={60}
          minLength={2}
          onChange={(event) => {
            setSettings((current) => ({ ...current, machineName: event.target.value }));
          }}
          required
          value={settings.machineName}
        />
      </label>

      <label className="form-field">
        <span>Impressora</span>
        <select
          aria-label="Impressora térmica"
          disabled={loading}
          onChange={(event) => {
            setSettings((current) => ({
              ...current,
              deviceName: event.target.value.length === 0 ? null : event.target.value,
            }));
          }}
          value={settings.deviceName ?? ''}
        >
          <option value="">Padrão do Windows</option>
          {!selectedPrinterExists && settings.deviceName !== null ? (
            <option value={settings.deviceName}>
              {settings.deviceName} · não encontrada agora
            </option>
          ) : null}
          {printers.map((printer) => (
            <option key={printer.name} value={printer.name}>
              {printer.displayName}
              {printer.isDefault ? ' · padrão' : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="form-field">
        <span>Largura da bobina</span>
        <select
          aria-label="Largura da bobina"
          disabled={loading}
          onChange={(event) => {
            setSettings((current) => ({
              ...current,
              paperWidthMm: Number(event.target.value) as ThermalPaperWidth,
            }));
          }}
          value={settings.paperWidthMm}
        >
          <option value={58}>58 mm</option>
          <option value={80}>80 mm</option>
        </select>
      </label>

      <div className="printing-settings__status">
        <span>{printers.length} impressora(s) detectada(s)</span>
        <button
          className="button button--ghost button--compact"
          disabled={loading || submitting}
          onClick={() => void load()}
          type="button"
        >
          <RefreshCw size={15} aria-hidden="true" />
          Atualizar impressoras
        </button>
      </div>

      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}

      <button className="button button--primary" disabled={loading || submitting} type="submit">
        <Printer size={17} aria-hidden="true" />
        Salvar impressão térmica
      </button>
    </form>
  );
}
