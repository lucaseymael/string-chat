// Small, local raster avatars only. Shared by the renderer and Node services.
export function cleanAvatar(value) {
  return typeof value === 'string' && value.length <= 18000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : '';
}
export function avatarContent(person, escape) {
  const image = cleanAvatar(person?.avatar);
  return image ? `<img src="${image}" alt="" draggable="false">` : escape((String(person?.name || '?').trim().split(/\s+/).map(word => [...word][0]).slice(0, 2).join('') || '?').toUpperCase());
}
export async function prepareAvatar(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Escolha uma imagem PNG, JPG, WebP ou GIF de até 10 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('Imagem inválida.');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 160;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#292c34'; ctx.fillRect(0, 0, 160, 160);
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 160, 160);
    for (const quality of [0.82, 0.65, 0.45, 0.25]) { const value = canvas.toDataURL('image/jpeg', quality); if (cleanAvatar(value)) return value; }
    throw new Error('Não foi possível reduzir a foto. Tente outra imagem.');
  } finally { bitmap.close(); }
}
