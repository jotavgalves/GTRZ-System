import { Cloud, CreditCard, KeyRound, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';

import type { CloudSyncStatus } from '@gtrz/contracts';

import { PrintingSettingsPanel } from './PrintingSettingsPanel';

function basisPointsToInput(value: number): string {
  return (value / 100).toFixed(2);
}

function inputToBasisPoints(value: string): number {
  const amount = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0 || amount > 100) {
    throw new Error('Informe uma taxa entre 0% e 100%.');
  }
  return Math.round(amount * 100);
}

export function SettingsPage(): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [terminalLoading, setTerminalLoading] = useState(true);
  const [terminalSubmitting, setTerminalSubmitting] = useState(false);
  const [terminalEventName, setTerminalEventName] = useState<string | null>(null);
  const [debitRate, setDebitRate] = useState('0.00');
  const [creditRate, setCreditRate] = useState('0.00');
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudSyncStatus | null>(null);
  const [cloudLoading, setCloudLoading] = useState(true);

  const loadCloudStatus = useCallback(async (): Promise<void> => {
    setCloudLoading(true);
    try {
      setCloudStatus(await window.gtrz.settings.getCloudSyncStatus());
    } finally {
      setCloudLoading(false);
    }
  }, []);

  useEffect(() => {
    async function loadPaymentTerminal(): Promise<void> {
      setTerminalLoading(true);
      setTerminalError(null);
      try {
        const [settings, session] = await Promise.all([
          window.gtrz.settings.getPaymentTerminal(),
          window.gtrz.session.getState(),
        ]);
        setDebitRate(basisPointsToInput(settings.debitRateBasisPoints));
        setCreditRate(basisPointsToInput(settings.creditRateBasisPoints));
        setTerminalEventName(session.activeEvent?.name ?? null);
      } catch (loadError: unknown) {
        setTerminalError(
          loadError instanceof Error
            ? loadError.message
            : 'Não foi possível carregar a configuração da maquininha.',
        );
      } finally {
        setTerminalLoading(false);
      }
    }

    void loadPaymentTerminal();
  }, []);

  useEffect(() => {
    void loadCloudStatus();
  }, [loadCloudStatus]);

  async function handleSubmit(formEvent: SyntheticEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    setSubmitting(true);
    setMessage(null);
    setError(null);

    try {
      if (newPassword !== confirmation) {
        throw new Error('A confirmação não corresponde à nova senha.');
      }

      await window.gtrz.settings.changeProductionPassword({
        currentPassword,
        newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setMessage('Senha de Produção alterada com segurança.');
    } catch (submitError: unknown) {
      setError(
        submitError instanceof Error ? submitError.message : 'Não foi possível alterar a senha.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTerminalSubmit(formEvent: SyntheticEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    setTerminalSubmitting(true);
    setTerminalMessage(null);
    setTerminalError(null);

    try {
      const settings = await window.gtrz.settings.updatePaymentTerminal({
        debitRateBasisPoints: inputToBasisPoints(debitRate),
        creditRateBasisPoints: inputToBasisPoints(creditRate),
      });
      setDebitRate(basisPointsToInput(settings.debitRateBasisPoints));
      setCreditRate(basisPointsToInput(settings.creditRateBasisPoints));
      setTerminalMessage('Taxas da maquininha salvas para este evento.');
    } catch (submitError: unknown) {
      setTerminalError(
        submitError instanceof Error
          ? submitError.message
          : 'Não foi possível salvar as taxas da maquininha.',
      );
    } finally {
      setTerminalSubmitting(false);
    }
  }

  return (
    <section className="feature-page">
      <header className="feature-header">
        <div>
          <span className="eyebrow">Acesso exclusivo da Produção</span>
          <h1>Configurações</h1>
          <p>Preferências administrativas e proteções do sistema offline.</p>
        </div>
        <span className="feature-icon" aria-hidden="true">
          <Settings size={26} />
        </span>
      </header>

      <div className="settings-grid">
        <article className="panel security-summary">
          <span className="security-summary__icon" aria-hidden="true">
            <ShieldCheck size={28} />
          </span>
          <div>
            <h2>Controle administrativo</h2>
            <p>
              O perfil Caixa não acessa eventos, ingressos, custos, margens, caixa administrativo,
              despesas, auditoria, backups ou configurações.
            </p>
          </div>
        </article>

        <form className="panel form-panel" onSubmit={(formEvent) => void handleSubmit(formEvent)}>
          <div className="panel__heading">
            <KeyRound size={20} aria-hidden="true" />
            <div>
              <h2>Senha de Produção</h2>
              <p>A senha inicial é 121225 e deve ser substituída antes do primeiro evento.</p>
            </div>
          </div>

          <label className="form-field">
            <span>Senha atual</span>
            <input
              autoComplete="current-password"
              onChange={(inputEvent) => {
                setCurrentPassword(inputEvent.target.value);
              }}
              required
              type="password"
              value={currentPassword}
            />
          </label>

          <label className="form-field">
            <span>Nova senha</span>
            <input
              autoComplete="new-password"
              minLength={6}
              onChange={(inputEvent) => {
                setNewPassword(inputEvent.target.value);
              }}
              required
              type="password"
              value={newPassword}
            />
          </label>

          <label className="form-field">
            <span>Confirmar nova senha</span>
            <input
              autoComplete="new-password"
              minLength={6}
              onChange={(inputEvent) => {
                setConfirmation(inputEvent.target.value);
              }}
              required
              type="password"
              value={confirmation}
            />
          </label>

          {error === null ? null : <p className="form-error">{error}</p>}
          {message === null ? null : <p className="form-success">{message}</p>}

          <button
            className="button button--primary"
            disabled={submitting || newPassword.length < 6 || confirmation.length < 6}
            type="submit"
          >
            <KeyRound size={17} aria-hidden="true" />
            Alterar senha
          </button>
        </form>

        <form
          className="panel form-panel"
          onSubmit={(formEvent) => void handleTerminalSubmit(formEvent)}
        >
          <div className="panel__heading">
            <CreditCard size={20} aria-hidden="true" />
            <div>
              <h2>Maquininha do evento</h2>
              <p>
                {terminalEventName === null
                  ? 'Opere um evento para definir as taxas da maquininha.'
                  : `Evento em operação: ${terminalEventName}`}
              </p>
            </div>
          </div>

          <label className="form-field">
            <span>Taxa débito (%)</span>
            <input
              disabled={terminalLoading || terminalEventName === null}
              inputMode="decimal"
              max="100"
              min="0"
              onChange={(inputEvent) => {
                setDebitRate(inputEvent.target.value);
              }}
              required
              step="0.01"
              type="number"
              value={debitRate}
            />
          </label>

          <label className="form-field">
            <span>Taxa crédito (%)</span>
            <input
              disabled={terminalLoading || terminalEventName === null}
              inputMode="decimal"
              max="100"
              min="0"
              onChange={(inputEvent) => {
                setCreditRate(inputEvent.target.value);
              }}
              required
              step="0.01"
              type="number"
              value={creditRate}
            />
          </label>

          {terminalError === null ? null : <p className="form-error">{terminalError}</p>}
          {terminalMessage === null ? null : <p className="form-success">{terminalMessage}</p>}

          <button
            className="button button--primary"
            disabled={terminalLoading || terminalSubmitting || terminalEventName === null}
            type="submit"
          >
            <CreditCard size={17} aria-hidden="true" />
            Salvar taxas da maquininha
          </button>
        </form>

        <article className="panel cloud-sync-panel">
          <div className="panel__heading">
            <Cloud size={20} aria-hidden="true" />
            <div>
              <h2>Conexão em nuvem</h2>
              <p>Cloudflare centraliza a validação do acesso e as operações em tempo real.</p>
            </div>
          </div>

          <div className="cloud-sync-panel__state">
            <span
              className={`cloud-sync-status cloud-sync-status--${cloudStatus?.connection ?? 'offline'}`}
            >
              {cloudLoading
                ? 'Testando conexão'
                : cloudStatus?.connection === 'connected'
                  ? 'Conectado'
                  : cloudStatus?.connection === 'attention'
                    ? 'Atenção necessária'
                    : 'Sem conexão'}
            </span>
            <span>{cloudStatus?.endpoint ?? 'API da nuvem'}</span>
          </div>

          <dl className="cloud-sync-panel__checks">
            <div>
              <dt>API</dt>
              <dd>{cloudStatus?.apiReachable ? 'Online' : 'Aguardando teste'}</dd>
            </div>
            <div>
              <dt>Credencial</dt>
              <dd>{cloudStatus?.credentialAccepted ? 'Validada' : 'Não validada'}</dd>
            </div>
          </dl>

          <p className={cloudStatus?.connection === 'connected' ? 'form-success' : 'form-error'}>
            {cloudLoading ? 'Consultando a API segura...' : (cloudStatus?.message ?? 'Teste indisponível.')}
          </p>

          <button
            className="button button--ghost"
            disabled={cloudLoading}
            onClick={() => void loadCloudStatus()}
            type="button"
          >
            <RefreshCw size={17} aria-hidden="true" />
            Testar conexão
          </button>
        </article>

        <PrintingSettingsPanel />
      </div>
    </section>
  );
}
