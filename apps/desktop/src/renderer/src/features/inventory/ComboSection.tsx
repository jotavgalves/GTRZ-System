import { PackageOpen, RefreshCw, Tags } from 'lucide-react';

import type { InventoryProduct } from '@gtrz/contracts';

import { ComboCard } from './ComboCard';
import { ComboForm } from './ComboForm';
import { useCombos } from './useCombos';

interface ComboSectionProps {
  readonly products: readonly InventoryProduct[];
  readonly production: boolean;
}

export function ComboSection({ products, production }: ComboSectionProps): React.JSX.Element {
  const { combos, loading, busy, error, message, reload, createCombo, updateCombo, deleteCombo } =
    useCombos(products);
  const activeProducts = products.filter((product) => product.active);

  return (
    <section className="combo-section" aria-labelledby="combo-section-title">
      <header className="combo-section__header">
        <div>
          <span className="eyebrow">Composição automática</span>
          <h2 id="combo-section-title">Combos</h2>
          <p>
            A disponibilidade é calculada pelo estoque dos componentes, sem criar saldo duplicado.
          </p>
        </div>
        <button
          className="button button--secondary button--compact"
          disabled={loading}
          onClick={() => {
            void reload();
          }}
          type="button"
        >
          <RefreshCw size={15} aria-hidden="true" />
          Atualizar combos
        </button>
      </header>

      {error === null ? null : <p className="form-error">{error}</p>}
      {message === null ? null : <p className="form-success">{message}</p>}

      {production ? (
        <article className="panel combo-create-panel">
          <div className="panel__heading">
            <Tags size={20} aria-hidden="true" />
            <div>
              <h2>Novo combo</h2>
              <p>Defina os produtos, as quantidades e o preço comercial do conjunto.</p>
            </div>
          </div>
          {activeProducts.length === 0 ? (
            <p className="inventory-helper">
              Cadastre ao menos um produto ativo para criar combos.
            </p>
          ) : (
            <ComboForm busy={busy} onSubmit={createCombo} products={activeProducts} />
          )}
        </article>
      ) : null}

      <div className="combo-list" aria-live="polite">
        {loading ? <div className="route-state">Carregando combos…</div> : null}
        {!loading && combos.length === 0 ? (
          <div className="empty-state">
            <PackageOpen size={32} aria-hidden="true" />
            <h2>Nenhum combo cadastrado</h2>
            <p>Os combos aparecerão aqui depois do primeiro cadastro.</p>
          </div>
        ) : null}
        {combos.map((combo) => (
          <ComboCard
            busy={busy}
            combo={combo}
            key={combo.id}
            onDelete={deleteCombo}
            onUpdate={updateCombo}
            production={production}
            products={products}
          />
        ))}
      </div>
    </section>
  );
}
