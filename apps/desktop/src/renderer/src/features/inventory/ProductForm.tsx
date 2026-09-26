import { ImagePlus, PackagePlus, Save, X } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';

import type {
  CreateProductInput,
  CreateExternalFoodItemInput,
  FoodState,
  InventoryProduct,
  ProductCategory,
  ProductFallbackIcon,
  UpdateProductInput,
} from '@gtrz/contracts';

import { PRODUCT_ICON_OPTIONS } from '../../shared/product/product-icon-options';
import { ProductVisual } from '../../shared/product/ProductVisual';

interface ProductFormBaseProps {
  readonly categories: readonly ProductCategory[];
  readonly busy: boolean;
}

interface CreateProductFormProps extends ProductFormBaseProps {
  readonly product?: undefined;
  readonly onSubmit: (input: CreateProductInput) => Promise<void>;
  readonly onCancel?: undefined;
  readonly onExternalFoodSubmit?: (input: CreateExternalFoodItemInput) => Promise<void>;
}

interface UpdateProductFormProps extends ProductFormBaseProps {
  readonly product: InventoryProduct;
  readonly onSubmit: (input: UpdateProductInput) => Promise<void>;
  readonly onCancel: () => void;
}

type ProductFormProps = CreateProductFormProps | UpdateProductFormProps;

function centsToInput(cents: number | undefined): string {
  return cents === undefined ? '' : (cents / 100).toFixed(2);
}

function inputToCents(value: string): number {
  const amount = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0)
    throw new Error('Informe valores monetários válidos.');
  return Math.round(amount * 100);
}

const MAX_IMAGE_DATA_URL_LENGTH = 730_000;
const MAX_IMAGE_DIMENSION = 1280;

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => {
      resolve(image);
    });
    image.addEventListener('error', () => {
      reject(new Error('Não foi possível ler a foto escolhida.'));
    });
    image.src = dataUrl;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('Não foi possível ler a foto escolhida.'));
    });
    reader.addEventListener('error', () => {
      reject(new Error('Não foi possível ler a foto escolhida.'));
    });
    reader.readAsDataURL(file);
  });
}

async function optimizeImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Escolha uma foto PNG, JPG ou WebP.');
  }
  const originalDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(originalDataUrl);
  const scale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  if (context === null) {
    throw new Error('Não foi possível preparar a foto para salvar.');
  }

  context.fillStyle = '#111114';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  for (const quality of [0.86, 0.78, 0.7, 0.62, 0.54]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) {
      return dataUrl;
    }
  }

  throw new Error('A foto é muito grande para o banco mesmo após otimização.');
}

export function ProductForm(props: ProductFormProps): React.JSX.Element {
  const [categoryId, setCategoryId] = useState(
    props.product?.categoryId ?? props.categories[0]?.id ?? '',
  );
  const [name, setName] = useState(props.product?.name ?? '');
  const [cost, setCost] = useState(centsToInput(props.product?.financials?.costCents));
  const [salePrice, setSalePrice] = useState(centsToInput(props.product?.salePriceCents));
  const [lowStockThreshold, setLowStockThreshold] = useState(
    String(props.product?.lowStockThreshold ?? 0),
  );
  const [active, setActive] = useState(props.product?.active ?? true);
  const [comboOnly, setComboOnly] = useState(props.product?.comboOnly ?? false);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(
    props.product?.imageDataUrl ?? null,
  );
  const [fallbackIcon, setFallbackIcon] = useState<ProductFallbackIcon>(
    props.product?.fallbackIcon ?? 'package',
  );
  const [error, setError] = useState<string | null>(null);
  const [foodState, setFoodState] = useState<FoodState | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [supplierUnit, setSupplierUnit] = useState('');
  const [commissionUnit, setCommissionUnit] = useState('');
  const [initialQuantity, setInitialQuantity] = useState('');
  const selectedCategory = props.categories.find((category) => category.id === categoryId);
  const usesFoodEngine = selectedCategory?.engine === 'food';
  const externalFood = usesFoodEngine && foodState?.supplierMode === 'external';
  const externalFoodComponent = externalFood && comboOnly;

  useEffect(() => {
    if (!usesFoodEngine || props.product !== undefined) return;
    void window.gtrz.food
      .getState()
      .then((next) => {
        setFoodState(next);
        setSupplierId((current) =>
          current !== '' ? current : (next.suppliers.find((supplier) => supplier.active)?.id ?? ''),
        );
      })
      .catch(() => {
        setFoodState(null);
      });
  }, [props.product, usesFoodEngine]);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      if (externalFood) {
        if (props.product !== undefined || props.onExternalFoodSubmit === undefined)
          throw new Error('Este item externo deve ser cadastrado pelo fluxo de estoque.');
        const quantity = Number(initialQuantity);
        if (!Number.isInteger(quantity) || quantity <= 0)
          throw new Error('Informe a quantidade recebida.');
        await props.onExternalFoodSubmit({
          categoryId,
          name,
          initialQuantity: quantity,
          comboOnly,
          ...(externalFoodComponent
            ? {}
            : {
                supplierId,
                supplierUnitCents: inputToCents(supplierUnit),
                commissionUnitCents: inputToCents(commissionUnit),
              }),
        });
        setName('');
        setSupplierUnit('');
        setCommissionUnit('');
        setInitialQuantity('');
        setComboOnly(false);
        return;
      }
      if (usesFoodEngine && foodState?.supplierMode === null)
        throw new Error(
          'Configure na aba Comida se a GTRZ ou um parceiro fornece este evento antes de cadastrar o item.',
        );
      const baseInput: CreateProductInput = {
        categoryId,
        name,
        kind: usesFoodEngine ? 'food' : 'drink',
        costCents: inputToCents(cost),
        salePriceCents: inputToCents(salePrice),
        lowStockThreshold: Number(lowStockThreshold),
        comboOnly,
        imageDataUrl,
        fallbackIcon,
      };
      if (!Number.isInteger(baseInput.lowStockThreshold) || baseInput.lowStockThreshold < 0) {
        throw new Error('O limite de estoque deve ser um número inteiro não negativo.');
      }
      if (props.product === undefined) {
        await props.onSubmit(baseInput);
        setName('');
        setCost('');
        setSalePrice('');
        setLowStockThreshold('0');
        setComboOnly(false);
        setImageDataUrl(null);
        setFallbackIcon('package');
      } else {
        await props.onSubmit({ ...baseInput, productId: props.product.id, active });
      }
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : 'Não foi possível salvar.');
    }
  }

  return (
    <form className="product-form" onSubmit={(event) => void handleSubmit(event)}>
      <div className="product-form__grid">
        <label className="form-field">
          <span>Nome</span>
          <input
            maxLength={100}
            minLength={2}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="Ex.: Budweiser lata"
            required
            value={name}
          />
        </label>
        <label className="form-field form-field--checkbox">
          <span>Venda</span>
          <span className="switch-field">
            <input
              checked={comboOnly}
              onChange={(event) => {
                setComboOnly(event.target.checked);
              }}
              type="checkbox"
            />
            <span aria-hidden="true" className="switch-field__track" />
            <span>Somente em combos</span>
          </span>
        </label>
        <label className="form-field">
          <span>Categoria</span>
          <select
            aria-label="Categoria"
            onChange={(event) => {
              setCategoryId(event.target.value);
            }}
            required
            value={categoryId}
          >
            <option value="">Selecione</option>
            {props.categories
              .filter((category) => category.active)
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
          </select>
        </label>
        {externalFood && !externalFoodComponent ? (
          <label className="form-field">
            <span>Fornecedor</span>
            <select
              onChange={(event) => {
                setSupplierId(event.target.value);
              }}
              required
              value={supplierId}
            >
              <option value="">Selecione</option>
              {foodState.suppliers
                .filter((supplier) => supplier.active)
                .map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <label className="form-field">
            <span>Ícone sem foto</span>
            <select
              aria-label="Ícone do produto"
              onChange={(event) => {
                setFallbackIcon(event.target.value as ProductFallbackIcon);
              }}
              value={fallbackIcon}
            >
              {PRODUCT_ICON_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {externalFood ? (
          <label className="form-field">
            <span>Quantidade recebida</span>
            <input
              min="1"
              onChange={(event) => {
                setInitialQuantity(event.target.value);
              }}
              required
              step="1"
              type="number"
              value={initialQuantity}
            />
          </label>
        ) : (
          <label className="form-field">
            <span>Preço de custo</span>
            <input
              inputMode="decimal"
              min="0"
              onChange={(event) => {
                setCost(event.target.value);
              }}
              placeholder="0,00"
              required
              step="0.01"
              type="number"
              value={cost}
            />
          </label>
        )}
        {externalFood && !externalFoodComponent ? (
          <label className="form-field">
            <span>Valor do fornecedor por un.</span>
            <input
              inputMode="decimal"
              min="0"
              onChange={(event) => {
                setSupplierUnit(event.target.value);
              }}
              placeholder="0,00"
              required
              step="0.01"
              type="number"
              value={supplierUnit}
            />
          </label>
        ) : externalFoodComponent ? (
          <div className="form-field product-form__context">
            <span>Componente do combo</span>
            <small>O fornecedor, o valor e a comissão serão definidos no combo de comida.</small>
          </div>
        ) : (
          <label className="form-field">
            <span>Preço de venda</span>
            <input
              inputMode="decimal"
              min="0"
              onChange={(event) => {
                setSalePrice(event.target.value);
              }}
              placeholder="0,00"
              required
              step="0.01"
              type="number"
              value={salePrice}
            />
          </label>
        )}
        {externalFood && !externalFoodComponent ? (
          <label className="form-field">
            <span>Comissão GTRZ por un.</span>
            <input
              inputMode="decimal"
              min="0"
              onChange={(event) => {
                setCommissionUnit(event.target.value);
              }}
              placeholder="0,00"
              required
              step="0.01"
              type="number"
              value={commissionUnit}
            />
          </label>
        ) : externalFoodComponent ? null : (
          <label className="form-field">
            <span>Aviso de estoque baixo</span>
            <input
              min="0"
              onChange={(event) => {
                setLowStockThreshold(event.target.value);
              }}
              required
              step="1"
              type="number"
              value={lowStockThreshold}
            />
          </label>
        )}
      </div>

      <div className="product-media-editor">
        <ProductVisual
          alt={name || 'Produto'}
          fallbackIcon={fallbackIcon}
          imageDataUrl={imageDataUrl}
        />
        <div>
          <strong>Foto do produto</strong>
          <small>PNG, JPG ou WebP. O sistema ajusta fotos grandes automaticamente.</small>
          <div className="product-media-editor__actions">
            <label className="button button--secondary button--compact">
              <ImagePlus size={15} aria-hidden="true" /> Escolher foto
              <input
                accept="image/png,image/jpeg,image/webp"
                className="visually-hidden"
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  if (file === undefined) return;
                  setError(null);
                  void optimizeImage(file)
                    .then((dataUrl) => {
                      setImageDataUrl(dataUrl);
                    })
                    .catch((imageError: unknown) => {
                      setError(imageError instanceof Error ? imageError.message : 'Foto inválida.');
                    })
                    .finally(() => {
                      input.value = '';
                    });
                }}
                type="file"
              />
            </label>
            {imageDataUrl === null ? null : (
              <button
                className="button button--ghost button--compact"
                onClick={() => {
                  setImageDataUrl(null);
                }}
                type="button"
              >
                <X size={15} aria-hidden="true" />
                Remover foto
              </button>
            )}
          </div>
        </div>
      </div>

      {props.product === undefined ? null : (
        <label className="checkbox-field">
          <input
            checked={active}
            onChange={(event) => {
              setActive(event.target.checked);
            }}
            type="checkbox"
          />
          Produto ativo para novas vendas
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
            categoryId.length === 0 ||
            name.trim().length < 2 ||
            (usesFoodEngine && foodState === null) ||
            (externalFood &&
              (initialQuantity.length === 0 || (!externalFoodComponent && supplierId.length === 0)))
          }
          type="submit"
        >
          {props.product === undefined ? (
            <PackagePlus size={17} aria-hidden="true" />
          ) : (
            <Save size={17} aria-hidden="true" />
          )}
          {props.product === undefined
            ? externalFood
              ? externalFoodComponent
                ? 'Cadastrar componente e dar entrada'
                : 'Cadastrar comida e dar entrada'
              : 'Cadastrar produto'
            : 'Salvar alterações'}
        </button>
      </div>
    </form>
  );
}
