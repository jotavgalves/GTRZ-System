import { ImagePlus, X } from 'lucide-react';

import type { ProductFallbackIcon } from '@gtrz/contracts';

import { optimizeImage } from './optimize-image';
import { PRODUCT_ICON_OPTIONS } from './product-icon-options';
import { ProductVisual } from './ProductVisual';

interface ProductPhotoEditorProps {
  readonly name: string;
  readonly title: string;
  readonly imageDataUrl: string | null;
  readonly fallbackIcon: ProductFallbackIcon;
  readonly disabled?: boolean;
  readonly onImageChange: (imageDataUrl: string | null) => void;
  readonly onIconChange: (icon: ProductFallbackIcon) => void;
  readonly onError: (message: string | null) => void;
}

/** Photo picker with the same rules as the product form: PNG, JPG or WebP, resized automatically. */
export function ProductPhotoEditor({
  name,
  title,
  imageDataUrl,
  fallbackIcon,
  disabled = false,
  onImageChange,
  onIconChange,
  onError,
}: ProductPhotoEditorProps): React.JSX.Element {
  return (
    <div className="product-media-editor">
      <ProductVisual alt={name} fallbackIcon={fallbackIcon} imageDataUrl={imageDataUrl} />
      <div>
        <strong>{title}</strong>
        <small>PNG, JPG ou WebP. O sistema ajusta fotos grandes automaticamente.</small>
        <div className="product-media-editor__actions">
          <label className="button button--secondary button--compact">
            <ImagePlus size={15} aria-hidden="true" /> Escolher foto
            <input
              accept="image/png,image/jpeg,image/webp"
              className="visually-hidden"
              disabled={disabled}
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (file === undefined) return;
                onError(null);
                void optimizeImage(file)
                  .then((dataUrl) => {
                    onImageChange(dataUrl);
                  })
                  .catch((imageError: unknown) => {
                    onError(imageError instanceof Error ? imageError.message : 'Foto inválida.');
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
              disabled={disabled}
              onClick={() => {
                onImageChange(null);
              }}
              type="button"
            >
              <X size={15} aria-hidden="true" />
              Remover foto
            </button>
          )}
        </div>
        {imageDataUrl === null ? (
          <label className="form-field">
            <span>Ícone sem foto</span>
            <select
              aria-label={`Ícone de ${name}`}
              disabled={disabled}
              onChange={(event) => {
                onIconChange(event.target.value as ProductFallbackIcon);
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
        ) : null}
      </div>
    </div>
  );
}
