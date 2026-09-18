import { Cloud, CreditCard, KeyRound, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';

import type { CloudSyncStatus, MobileOperator, MobileOperatorRole } from '@gtrz/contracts';

import { PrintingSettingsPanel } from './PrintingSettingsPanel';
import { CategoryForm } from '../inventory/CategoryForm';
import { useInventory } from '../inventory/useInventory';

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
  const {
    state: inventoryState,
    busy: inventoryBusy,
    createCategory,
    updateCategory,
    deleteCategory,
  } = useInventory();
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
  const [mobileOperators, setMobileOperators] = useState<readonly MobileOperator[]>([]);
  const [mobileLoading, setMobileLoading] = useState(true);
  const [mobileName, setMobileName] = useState('');
  const [mobilePassword, setMobilePassword] = useState('');
  const [mobileRole, setMobileRole] = useState<MobileOperatorRole>('sales');
  const [mobileMessage, setMobileMessage] = useState<string | null>(null);
  const [mobileError, setMobileError] = useState<string | null>(null);

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

  const loadMobileOperators = useCallback(async (): Promise<void> => {
    setMobileLoading(true);
    try {
      setMobileOperators(await window.gtrz.settings.listMobileOperators());
    } catch (loadError: unknown) {
      setMobileError(loadError instanceof Error ? loadError.message : 'Não foi possível carregar os perfis móveis.');
    } finally {
      setMobileLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMobileOperators();
  }, [loadMobileOperators]);

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

  async function handleMobileOperatorSubmit(formEvent: SyntheticEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    setMobileError(null);
    setMobileMessage(null);
    try {
      await window.gtrz.settings.createMobileOperator({
        name: mobileName,
        password: mobilePassword,
        role: mobileRole,
      });
      setMobileName('');
      setMobilePassword('');
      setMobileRole('sales');
      setMobileMessage('Perfil móvel criado e disponível imediatamente.');
      await loadMobileOperators();
    } catch (submitError: unknown) {
      setMobileError(submitError instanceof Error ? submitError.message : 'Não foi possível criar o perfil.');
    }
  }

  async function changeMobileOperator(
    operator: MobileOperator,
    changes: { readonly role?: MobileOperatorRole; readonly active?: boolean },
  ): Promise<void> {
    setMobileError(null);
    try {
      await window.gtrz.settings.updateMobileOperator({ operatorId: operator.id, ...changes });
      await loadMobileOperators();
    } catch (updateError: unknown) {
      setMobileError(updateError instanceof Error ? updateError.message : 'Não foi possível atualizar o perfil.');
    }
  }

  async function requireMobilePassword(operator: MobileOperator): Promise<void> {
    setMobileError(null);
    try {
      await window.gtrz.settings.endMobileOperatorSessions({
        operatorId: operator.id,
        reason: 'password-required',
      });
      setMobileMessage(`A senha foi solicitada novamente para ${operator.name}.`);
      await loadMobileOperators();
    } catch (sessionError: unknown) {
      setMobileError(sessionError instanceof Error ? sessionError.message : 'Não foi possível encerrar a sessão.');
    }
  }

  async function deleteMobileOperator(operator: MobileOperator): Promise<void> {
    if (!window.confirm(`Excluir o perfil móvel de ${operator.name}? As sessões dele serão encerradas.`)) return;
    setMobileError(null);
    try {
      await window.gtrz.settings.deleteMobileOperator({ operatorId: operator.id });
      setMobileMessage(`Perfil de ${operator.name} excluído.`);
      await loadMobileOperators();
    } catch (deleteError: unknown) {
      setMobileError(deleteError instanceof Error ? deleteError.message : 'Não foi possível excluir o perfil.');
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
        <form className="panel form-panel" onSubmit={(formEvent) => void handleMobileOperatorSubmit(formEvent)}>
          <div className="panel__heading">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <h2>Perfis da operação mobile</h2>
              <p>O celular entra somente com a senha. Permissões mudam pela nuvem em tempo real.</p>
            </div>
          </div>
          <label className="form-field"><span>Nome da pessoa</span><input value={mobileName} onChange={(event) => setMobileName(event.target.value)} minLength={2} maxLength={60} required /></label>
          <label className="form-field"><span>Senha de acesso</span><input value={mobilePassword} onChange={(event) => setMobilePassword(event.target.value)} minLength={6} maxLength={128} type="password" required /></label>
          <label className="form-field"><span>Permissão</span><select value={mobileRole} onChange={(event) => setMobileRole(event.target.value as MobileOperatorRole)}><option value="sales">Venda</option><option value="inventory">Estoque</option><option value="sales-and-inventory">Estoque e venda</option></select></label>
          {mobileError === null ? null : <p className="form-error">{mobileError}</p>}
          {mobileMessage === null ? null : <p className="form-success">{mobileMessage}</p>}
          <button className="button button--primary" disabled={mobileLoading || mobilePassword.length < 6} type="submit"><ShieldCheck size={17} aria-hidden="true" />Criar perfil mobile</button>
          <div className="mobile-operator-list">
            {mobileLoading ? <p className="form-muted">Carregando perfis da nuvem...</p> : mobileOperators.length === 0 ? <p className="form-muted">Nenhum perfil móvel criado.</p> : mobileOperators.map((operator) => <article className="mobile-operator" key={operator.id}><div><strong>{operator.name}</strong><span>{operator.role === 'sales' ? 'Venda' : operator.role === 'inventory' ? 'Estoque' : 'Estoque e venda'} · {operator.active ? `${operator.sessionCount} sessão(ões)` : 'Desativado'}</span></div><div className="mobile-operator__actions"><select aria-label={`Permissão de ${operator.name}`} disabled={!operator.active} value={operator.role} onChange={(event) => void changeMobileOperator(operator, { role: event.target.value as MobileOperatorRole })}><option value="sales">Venda</option><option value="inventory">Estoque</option><option value="sales-and-inventory">Ambos</option></select><button className="button button--ghost" onClick={() => void requireMobilePassword(operator)} type="button">Pedir senha</button><button className="button button--ghost" onClick={() => void changeMobileOperator(operator, { active: !operator.active })} type="button">{operator.active ? 'Desativar' : 'Ativar'}</button><button className="button button--ghost" onClick={() => void deleteMobileOperator(operator)} type="button">Excluir</button></div></article>) }
          </div>
        </form>
        <article className="panel form-panel">
          <div className="panel__heading">
            <Settings size={20} aria-hidden="true" />
            <div>
              <h2>Categorias de estoque</h2>
              <p>A categoria Comida aciona o motor próprio de comida.</p>
            </div>
          </div>
          <CategoryForm
            busy={inventoryBusy}
            categories={inventoryState?.categories ?? []}
            onDelete={deleteCategory}
            onSubmit={createCategory}
            onUpdate={updateCategory}
          />
        </article>
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
            {cloudLoading
              ? 'Consultando a API segura...'
              : (cloudStatus?.message ?? 'Teste indisponível.')}
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
