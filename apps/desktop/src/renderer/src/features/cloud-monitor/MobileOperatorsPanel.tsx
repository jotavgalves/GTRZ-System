import { KeyRound, Pencil, ShieldCheck, UserRoundCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';

import type { MobileOperator, MobileOperatorRole } from '@gtrz/contracts';

function roleLabel(role: MobileOperatorRole): string {
  if (role === 'sales') return 'Venda';
  if (role === 'inventory') return 'Estoque';
  return 'Estoque e venda';
}

function formatLastSeen(timestamp: number | null): string {
  if (timestamp === null) return 'Nunca acessou';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(
    timestamp,
  );
}

export function MobileOperatorsPanel(): React.JSX.Element {
  const [operators, setOperators] = useState<readonly MobileOperator[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<MobileOperatorRole>('sales');
  const [editing, setEditing] = useState<MobileOperator | null>(null);
  const [editName, setEditName] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setOperators(await window.gtrz.settings.listMobileOperators());
      setError(null);
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Não foi possível carregar os perfis móveis.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createOperator(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      await window.gtrz.settings.createMobileOperator({ name, password, role });
      setName('');
      setPassword('');
      setRole('sales');
      setMessage('Perfil criado. O celular já pode entrar com esta senha.');
      await load();
    } catch (createError: unknown) {
      setError(
        createError instanceof Error ? createError.message : 'Não foi possível criar o perfil.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function updateOperator(
    operator: MobileOperator,
    changes: {
      readonly name?: string;
      readonly password?: string;
      readonly role?: MobileOperatorRole;
      readonly active?: boolean;
    },
  ): Promise<boolean> {
    setError(null);
    try {
      await window.gtrz.settings.updateMobileOperator({ operatorId: operator.id, ...changes });
      await load();
      return true;
    } catch (updateError: unknown) {
      setError(
        updateError instanceof Error ? updateError.message : 'Não foi possível atualizar o perfil.',
      );
      return false;
    }
  }

  async function saveEdit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (editing === null) return;
    setSubmitting(true);
    try {
      const updated = await updateOperator(editing, {
        ...(editName.trim() === editing.name ? {} : { name: editName.trim() }),
        ...(editPassword.length === 0 ? {} : { password: editPassword }),
      });
      if (!updated) return;
      setEditing(null);
      setEditPassword('');
      setMessage(`Perfil de ${editName.trim()} atualizado.`);
    } finally {
      setSubmitting(false);
    }
  }

  async function requirePassword(operator: MobileOperator): Promise<void> {
    setError(null);
    try {
      await window.gtrz.settings.endMobileOperatorSessions({
        operatorId: operator.id,
        reason: 'password-required',
      });
      setMessage(`Nova senha exigida para ${operator.name}.`);
      await load();
    } catch (sessionError: unknown) {
      setError(
        sessionError instanceof Error
          ? sessionError.message
          : 'Não foi possível encerrar a sessão.',
      );
    }
  }

  async function deleteOperator(operator: MobileOperator): Promise<void> {
    if (
      !window.confirm(
        `Excluir o perfil mobile de ${operator.name}? As sessões dele serão encerradas.`,
      )
    )
      return;
    setError(null);
    try {
      await window.gtrz.settings.deleteMobileOperator({ operatorId: operator.id });
      if (editing?.id === operator.id) setEditing(null);
      setMessage(`Perfil de ${operator.name} excluído.`);
      await load();
    } catch (deleteError: unknown) {
      setError(
        deleteError instanceof Error ? deleteError.message : 'Não foi possível excluir o perfil.',
      );
    }
  }

  function openEdit(operator: MobileOperator): void {
    setEditing(operator);
    setEditName(operator.name);
    setEditPassword('');
    setMessage(null);
    setError(null);
  }

  return (
    <section className="panel cloud-mobile-operators">
      <div className="panel__heading">
        <UserRoundCheck size={20} aria-hidden="true" />
        <div>
          <h2>Perfis mobile</h2>
          <p>Senhas, acesso e permissões enviados aos celulares em tempo real.</p>
        </div>
      </div>

      <form
        className="cloud-mobile-operators__create"
        onSubmit={(event) => void createOperator(event)}
      >
        <label className="form-field">
          <span>Nome</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            minLength={2}
            maxLength={60}
            required
          />
        </label>
        <label className="form-field">
          <span>Senha</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={6}
            maxLength={128}
            type="password"
            required
          />
        </label>
        <label className="form-field">
          <span>Permissão</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as MobileOperatorRole)}
          >
            <option value="sales">Venda</option>
            <option value="inventory">Estoque</option>
            <option value="sales-and-inventory">Estoque e venda</option>
          </select>
        </label>
        <button
          className="button button--primary"
          disabled={submitting || password.length < 6}
          type="submit"
        >
          <ShieldCheck size={17} aria-hidden="true" />
          Criar perfil
        </button>
      </form>

      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}

      {editing === null ? null : (
        <form className="cloud-mobile-operators__edit" onSubmit={(event) => void saveEdit(event)}>
          <div>
            <strong>Editar {editing.name}</strong>
            <span>Deixe a senha em branco para mantê-la.</span>
          </div>
          <label className="form-field">
            <span>Nome</span>
            <input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              minLength={2}
              maxLength={60}
              required
            />
          </label>
          <label className="form-field">
            <span>Nova senha</span>
            <input
              value={editPassword}
              onChange={(event) => setEditPassword(event.target.value)}
              minLength={0}
              maxLength={128}
              type="password"
            />
          </label>
          <div className="cloud-mobile-operators__edit-actions">
            <button
              className="button button--primary"
              disabled={submitting || (editPassword.length > 0 && editPassword.length < 6)}
              type="submit"
            >
              <Pencil size={16} aria-hidden="true" />
              Salvar
            </button>
            <button className="button button--ghost" onClick={() => setEditing(null)} type="button">
              <X size={16} aria-hidden="true" />
              Cancelar
            </button>
          </div>
        </form>
      )}

      <div className="cloud-mobile-operators__list">
        {loading ? (
          <p className="cloud-empty">Carregando perfis da nuvem...</p>
        ) : operators.length === 0 ? (
          <p className="cloud-empty">Nenhum perfil mobile criado.</p>
        ) : (
          operators.map((operator) => (
            <article className="cloud-mobile-operator" key={operator.id}>
              <div className="cloud-mobile-operator__identity">
                <span
                  className={
                    operator.active
                      ? 'cloud-mobile-operator__status'
                      : 'cloud-mobile-operator__status cloud-mobile-operator__status--inactive'
                  }
                  aria-label={operator.active ? 'Ativo' : 'Desativado'}
                />
                <div>
                  <strong>{operator.name}</strong>
                  <small>{`${roleLabel(operator.role)} · ${operator.active ? `${String(operator.sessionCount)} sessão(ões)` : 'Desativado'} · ${formatLastSeen(operator.lastSeenAt)}`}</small>
                </div>
              </div>
              <div className="cloud-mobile-operator__actions">
                <select
                  aria-label={`Permissão de ${operator.name}`}
                  disabled={!operator.active}
                  value={operator.role}
                  onChange={(event) =>
                    void updateOperator(operator, {
                      role: event.target.value as MobileOperatorRole,
                    })
                  }
                >
                  <option value="sales">Venda</option>
                  <option value="inventory">Estoque</option>
                  <option value="sales-and-inventory">Estoque e venda</option>
                </select>
                <button
                  className="button button--ghost"
                  onClick={() => openEdit(operator)}
                  type="button"
                  title="Editar perfil"
                >
                  <Pencil size={16} aria-hidden="true" />
                  Editar
                </button>
                <button
                  className="button button--ghost"
                  onClick={() => void requirePassword(operator)}
                  type="button"
                  title="Exigir senha novamente"
                >
                  <KeyRound size={16} aria-hidden="true" />
                  Senha
                </button>
                <button
                  className="button button--ghost"
                  onClick={() => void updateOperator(operator, { active: !operator.active })}
                  type="button"
                >
                  {operator.active ? 'Desativar' : 'Ativar'}
                </button>
                <button
                  className="button button--danger"
                  onClick={() => void deleteOperator(operator)}
                  type="button"
                >
                  Excluir
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
