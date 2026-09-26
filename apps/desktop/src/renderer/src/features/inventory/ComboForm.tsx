import { ChevronDown, ChevronUp, PackagePlus, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type SyntheticEvent } from 'react';

import type {
  ComboComponentInput,
  ComboKind,
  CreateComboInput,
  InventoryCombo,
  InventoryProduct,
  FoodState,
  UpdateComboInput,
} from '@gtrz/contracts';

interface ComboFormBaseProps {
  readonly products: readonly InventoryProduct[];
  readonly busy: boolean;
}

interface CreateComboFormProps extends ComboFormBaseProps {
  readonly combo?: undefined;
  readonly onSubmit: (input: CreateComboInput) => Promise<void>;
  readonly onCancel?: undefined;
}

interface UpdateComboFormProps extends ComboFormBaseProps {
  readonly combo: InventoryCombo;
  readonly onSubmit: (input: UpdateComboInput) => Promise<void>;
  readonly onCancel: () => void;
}

type ComboFormProps = CreateComboFormProps | UpdateComboFormProps;

function centsToInput(cents: number | undefined): string {
  return cents === undefined ? '' : (cents / 100).toFixed(2);
}

function inputToCents(value: string): number {
  const amount = Number(value.trim().replace(',', '.'));

  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Informe um preço válido para o combo.');
  }

  return Math.round(amount * 100);
}

function initialComponents(combo: InventoryCombo | undefined): ComboComponentInput[] {
  return (
    combo?.components.map((component) => ({
      productId: component.productId,
      quantity: component.quantity,
      ...(component.choiceGroup === null
        ? {}
        : {
            choiceGroup: component.choiceGroup,
            choiceLabel: component.choiceLabel ?? component.choiceGroup,
          }),
    })) ?? []
  );
}

export function ComboForm(props: ComboFormProps): React.JSX.Element {
  const activeProducts = useMemo(
    () => props.products.filter((product) => product.active),
    [props.products],
  );
  const [name, setName] = useState(props.combo?.name ?? '');
  const [kind, setKind] = useState<ComboKind>(props.combo?.kind ?? 'drink');
  const [salePrice, setSalePrice] = useState(centsToInput(props.combo?.salePriceCents));
  const [components, setComponents] = useState<ComboComponentInput[]>(
    initialComponents(props.combo),
  );
  const [selectedProductId, setSelectedProductId] = useState(activeProducts[0]?.id ?? '');
  const [selectedQuantity, setSelectedQuantity] = useState('1');
  const [choiceEnabled, setChoiceEnabled] = useState(false);
  const [choiceGroup, setChoiceGroup] = useState('');
  const [choiceLabel, setChoiceLabel] = useState('');
  const [active, setActive] = useState(props.combo?.active ?? true);
  const [foodState, setFoodState] = useState<FoodState | null>(null);
  const [supplierId, setSupplierId] = useState(props.combo?.externalFoodTerms?.supplierId ?? '');
  const [supplierUnit, setSupplierUnit] = useState(
    centsToInput(props.combo?.externalFoodTerms?.supplierUnitCents),
  );
  const [commissionUnit, setCommissionUnit] = useState(
    centsToInput(props.combo?.externalFoodTerms?.commissionUnitCents),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== 'food') return;
    void window.gtrz.food
      .getState()
      .then((next) => {
        setFoodState(next);
        setSupplierId((current) =>
          current !== '' ? current : (next.suppliers.find((supplier) => supplier.active)?.id ?? ''),
        );
      })
      .catch(() => setFoodState(null));
  }, [kind]);

  const externalFood = kind === 'food' && foodState?.supplierMode === 'external';
  const externalFoodSalePriceCents = externalFood
    ? inputToCents(supplierUnit) + inputToCents(commissionUnit)
    : null;

  const selectedChoiceGroup = choiceEnabled ? choiceGroup.trim() || null : null;
  const availableProducts = activeProducts.filter(
    (product) =>
      !components.some(
        (component) =>
          component.productId === product.id &&
          (component.choiceGroup ?? null) === selectedChoiceGroup,
      ),
  );

  function addComponent(): void {
    setError(null);
    const quantity = Number(selectedQuantity);

    if (selectedProductId.length === 0 || !Number.isInteger(quantity) || quantity <= 0) {
      setError('Selecione um produto e informe uma quantidade inteira positiva.');
      return;
    }

    const normalizedGroup = choiceGroup.trim();
    const normalizedLabel = choiceLabel.trim();
    if (choiceEnabled && (normalizedGroup.length === 0 || normalizedLabel.length === 0)) {
      setError(
        'Informe o identificador e o rótulo da escolha, como “arepas” e “Escolha as arepas”.',
      );
      return;
    }
    const groupQuantity = choiceEnabled
      ? components.find((component) => component.choiceGroup === normalizedGroup)?.quantity
      : undefined;
    if (groupQuantity !== undefined && groupQuantity !== quantity) {
      setError('Todas as opções da mesma escolha precisam usar a mesma quantidade.');
      return;
    }
    setComponents((current) => [
      ...current,
      {
        productId: selectedProductId,
        quantity,
        ...(choiceEnabled ? { choiceGroup: normalizedGroup, choiceLabel: normalizedLabel } : {}),
      },
    ]);
    const nextProduct = availableProducts.find((product) => product.id !== selectedProductId);
    setSelectedProductId(nextProduct?.id ?? '');
    setSelectedQuantity('1');
  }

  function updateComponentQuantity(
    productId: string,
    choiceGroup: string | undefined,
    quantityValue: string,
  ): void {
    const quantity = Number(quantityValue);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return;
    }

    setComponents((current) =>
      current.map((component) =>
        component.productId === productId && component.choiceGroup === choiceGroup
          ? { ...component, quantity }
          : component,
      ),
    );
  }

  function moveComponent(index: number, direction: -1 | 1): void {
    setComponents((current) => {
      const groups: ComboComponentInput[][] = [];
      for (const component of current) {
        if (component.choiceGroup === undefined) {
          groups.push([component]);
          continue;
        }
        const existing = groups.find(
          (group) => group[0]?.choiceGroup === component.choiceGroup,
        );
        if (existing === undefined) groups.push([component]);
        else existing.push(component);
      }
      const target = current[index];
      if (target === undefined) return current;
      const groupIndex = groups.findIndex((group) => group.includes(target));
      const nextIndex = groupIndex + direction;
      if (groupIndex < 0 || nextIndex < 0 || nextIndex >= groups.length) return current;
      [groups[groupIndex], groups[nextIndex]] = [groups[nextIndex]!, groups[groupIndex]!];
      return groups.flat();
    });
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    try {
      if (components.length === 0) {
        throw new Error('Adicione pelo menos um produto ao combo.');
      }

      const orderedComponents = components.map((component, index) => ({
        ...component,
        sortOrder: index,
      }));
      const baseInput: CreateComboInput = {
        name,
        kind,
        salePriceCents: externalFood ? externalFoodSalePriceCents ?? 0 : inputToCents(salePrice),
        components: orderedComponents,
        ...(externalFood
          ? {
              externalFoodTerms: {
                supplierId,
                supplierUnitCents: inputToCents(supplierUnit),
                commissionUnitCents: inputToCents(commissionUnit),
              },
            }
          : {}),
      };

      if (props.combo === undefined) {
        await props.onSubmit(baseInput);
        setName('');
        setSalePrice('');
        setComponents([]);
        setSupplierUnit('');
        setCommissionUnit('');
      } else {
        await props.onSubmit({
          ...baseInput,
          comboId: props.combo.id,
          active,
        });
      }
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : 'Não foi possível salvar.');
    }
  }

  return (
    <form className="combo-form" onSubmit={(event) => void handleSubmit(event)}>
      <div className="combo-form__main-fields">
        <label className="form-field">
          <span>Nome do combo</span>
          <input
            maxLength={100}
            minLength={2}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="Ex.: Balde com 10 Budweiser"
            required
            value={name}
          />
        </label>

        <label className="form-field">
          <span>Preço do combo</span>
          <input
            inputMode="decimal"
            min="0"
            disabled={externalFood}
            onChange={(event) => {
              setSalePrice(event.target.value);
            }}
            placeholder="0,00"
            required
            step="0.01"
            type="number"
            value={externalFood ? centsToInput(externalFoodSalePriceCents ?? 0) : salePrice}
          />
        </label>
        <label className="form-field">
          <span>Tipo do combo</span>
          <select
            onChange={(event) => {
              setKind(event.target.value as ComboKind);
            }}
            value={kind}
          >
            <option value="drink">Bebida</option>
            <option value="food">Comida</option>
          </select>
        </label>
      </div>

      {externalFood ? (
        <div className="combo-form__main-fields">
          <label className="form-field">
            <span>Fornecedor</span>
            <select onChange={(event) => setSupplierId(event.target.value)} required value={supplierId}>
              <option value="">Selecione</option>
              {foodState?.suppliers
                .filter((supplier) => supplier.active)
                .map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="form-field">
            <span>Valor do fornecedor por combo</span>
            <input inputMode="decimal" min="0" onChange={(event) => setSupplierUnit(event.target.value)} required step="0.01" type="number" value={supplierUnit} />
          </label>
          <label className="form-field">
            <span>Comissão GTRZ por combo</span>
            <input inputMode="decimal" min="0" onChange={(event) => setCommissionUnit(event.target.value)} required step="0.01" type="number" value={commissionUnit} />
          </label>
        </div>
      ) : null}

      <div className="combo-component-picker">
        <label className="form-field">
          <span>Produto</span>
          <select
            aria-label="Produto do combo"
            disabled={availableProducts.length === 0}
            onChange={(event) => {
              setSelectedProductId(event.target.value);
            }}
            value={selectedProductId}
          >
            <option value="">Selecione</option>
            {availableProducts.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>

        <label className="combo-choice-toggle">
          <input
            checked={choiceEnabled}
            onChange={(event) => {
              setChoiceEnabled(event.target.checked);
            }}
            type="checkbox"
          />
          <span>É uma escolha?</span>
        </label>

        {choiceEnabled ? (
          <>
            <label className="form-field">
              <span>Grupo da escolha</span>
              <input
                onChange={(event) => {
                  setChoiceGroup(event.target.value);
                }}
                placeholder="Ex.: arepas"
                value={choiceGroup}
              />
            </label>
            <label className="form-field">
              <span>Rótulo para o caixa</span>
              <input
                onChange={(event) => {
                  setChoiceLabel(event.target.value);
                }}
                placeholder="Ex.: Escolha as arepas"
                value={choiceLabel}
              />
            </label>
          </>
        ) : null}

        <label className="form-field">
          <span>Quantidade</span>
          <input
            aria-label="Quantidade do componente"
            min="1"
            onChange={(event) => {
              setSelectedQuantity(event.target.value);
            }}
            step="1"
            type="number"
            value={selectedQuantity}
          />
        </label>

        <button
          className="button button--secondary"
          disabled={props.busy || selectedProductId.length === 0}
          onClick={addComponent}
          type="button"
        >
          <Plus size={16} aria-hidden="true" />
          Adicionar componente
        </button>
      </div>

      <div className="combo-component-list">
        {components.length === 0 ? (
          <p className="inventory-helper">Nenhum componente adicionado.</p>
        ) : (
          components.map((component, index) => {
            const product = props.products.find((item) => item.id === component.productId);

            return (
              <div
                className="combo-component-row"
                key={`${component.choiceGroup ?? 'fixed'}-${component.productId}`}
              >
                <span>
                  {product?.name ?? 'Produto indisponível'}
                  {component.choiceLabel === undefined ? null : (
                    <small>Escolha: {component.choiceLabel}</small>
                  )}
                </span>
                <label>
                  <span className="sr-only">Quantidade de {product?.name ?? 'produto'}</span>
                  <input
                    aria-label={`Quantidade de ${product?.name ?? 'produto'}`}
                    min="1"
                    onChange={(event) => {
                      updateComponentQuantity(
                        component.productId,
                        component.choiceGroup,
                        event.target.value,
                      );
                    }}
                    step="1"
                    type="number"
                    value={component.quantity}
                  />
                </label>
                <button
                  aria-label={`Mover ${product?.name ?? 'produto'} para cima`}
                  className="icon-button"
                  disabled={props.busy || index === 0}
                  onClick={() => moveComponent(index, -1)}
                  type="button"
                >
                  <ChevronUp size={15} aria-hidden="true" />
                </button>
                <button
                  aria-label={`Mover ${product?.name ?? 'produto'} para baixo`}
                  className="icon-button"
                  disabled={props.busy || index === components.length - 1}
                  onClick={() => moveComponent(index, 1)}
                  type="button"
                >
                  <ChevronDown size={15} aria-hidden="true" />
                </button>
                <button
                  aria-label={`Remover ${product?.name ?? 'produto'}`}
                  className="icon-button"
                  disabled={props.busy}
                  onClick={() => {
                    setComponents((current) =>
                      current.filter(
                        (item) =>
                          item.productId !== component.productId ||
                          item.choiceGroup !== component.choiceGroup,
                      ),
                    );
                  }}
                  type="button"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            );
          })
        )}
      </div>

      {props.combo === undefined ? null : (
        <label className="checkbox-field">
          <input
            checked={active}
            onChange={(event) => {
              setActive(event.target.checked);
            }}
            type="checkbox"
          />
          Combo ativo para novas vendas
        </label>
      )}

      {error === null ? null : <p className="form-error">{error}</p>}

      <div className="product-form__actions">
        {props.onCancel === undefined ? null : (
          <button
            className="button button--ghost"
            disabled={props.busy}
            onClick={props.onCancel}
            type="button"
          >
            <X size={16} aria-hidden="true" />
            Cancelar
          </button>
        )}
        <button
          className="button button--primary"
          disabled={
            props.busy ||
            name.trim().length < 2 ||
            components.length === 0 ||
            (externalFood && (supplierId.length === 0 || supplierUnit.length === 0 || commissionUnit.length === 0))
          }
          type="submit"
        >
          {props.combo === undefined ? (
            <PackagePlus size={17} aria-hidden="true" />
          ) : (
            <Save size={17} aria-hidden="true" />
          )}
          {props.combo === undefined ? 'Cadastrar combo' : 'Salvar combo'}
        </button>
      </div>
    </form>
  );
}
