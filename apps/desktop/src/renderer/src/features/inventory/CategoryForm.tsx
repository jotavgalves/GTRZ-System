import { Check, FolderPlus, Pencil, Trash2, X } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import type { ProductCategory } from '@gtrz/contracts';

interface CategoryFormProps {
  readonly busy: boolean;
  readonly categories: readonly ProductCategory[];
  readonly onSubmit: (name: string) => Promise<void>;
  readonly onUpdate: (id: string, name: string) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}
export function CategoryForm({
  busy,
  categories,
  onSubmit,
  onUpdate,
  onDelete,
}: CategoryFormProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    try {
      await onSubmit(name);
      setName('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar.');
    }
  };
  return (
    <>
      <form className="category-form" onSubmit={(event) => void submit(event)}>
        <label className="form-field">
          <span>Nova categoria</span>
          <input
            maxLength={60}
            minLength={2}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="Ex.: Cervejas"
            required
            value={name}
          />
        </label>
        <button
          className="button button--secondary"
          disabled={busy || name.trim().length < 2}
          type="submit"
        >
          <FolderPlus size={16} aria-hidden="true" />
          Criar categoria
        </button>
      </form>
      {error === null ? null : <p className="form-error">{error}</p>}
      <div className="category-manager">
        {categories.map((category) =>
          editing === category.id ? (
            <form
              className="category-manager__edit"
              key={category.id}
              onSubmit={(event) => {
                event.preventDefault();
                void onUpdate(category.id, draft)
                  .then(() => {
                    setEditing(null);
                  })
                  .catch((reason: unknown) => {
                    setError(
                      reason instanceof Error ? reason.message : 'Não foi possível atualizar.',
                    );
                  });
              }}
            >
              <input
                autoFocus
                maxLength={60}
                minLength={2}
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
                required
                value={draft}
              />
              <button
                aria-label="Salvar categoria"
                className="icon-button"
                disabled={busy}
                type="submit"
              >
                <Check size={15} />
              </button>
              <button
                aria-label="Cancelar edição"
                className="icon-button"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                }}
                type="button"
              >
                <X size={15} />
              </button>
            </form>
          ) : (
            <div className="category-manager__row" key={category.id}>
              <span>{category.name}</span>
              <button
                aria-label={`Editar ${category.name}`}
                className="icon-button"
                disabled={busy}
                onClick={() => {
                  setEditing(category.id);
                  setDraft(category.name);
                }}
                type="button"
              >
                <Pencil size={14} />
              </button>
              <button
                aria-label={`Excluir ${category.name}`}
                className="icon-button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Excluir a categoria ${category.name}?`))
                    void onDelete(category.id).catch((reason: unknown) => {
                      setError(
                        reason instanceof Error ? reason.message : 'Não foi possível excluir.',
                      );
                    });
                }}
                type="button"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ),
        )}
      </div>
    </>
  );
}
