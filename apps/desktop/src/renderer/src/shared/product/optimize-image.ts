/** Resizes a chosen photo and returns a JPEG data URL small enough for the database. */
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

export async function optimizeImage(file: File): Promise<string> {
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
