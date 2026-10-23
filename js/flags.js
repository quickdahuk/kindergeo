// Emoji flags from ISO country codes, shown only where the device can draw
// them (phones and Macs can; Windows shows two letters instead).

export function flagEmoji(iso2) {
  if (!/^[A-Z]{2}$/.test(iso2 || '')) return '';
  return String.fromCodePoint(...[...iso2].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

let supported;

export function canShowFlags() {
  if (supported !== undefined) return supported;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = '28px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(flagEmoji('FR'), 0, 2);
    const px = ctx.getImageData(0, 0, 32, 32).data;
    let colourful = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 100 && Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 80) colourful++;
    }
    supported = colourful > 20;
  } catch {
    supported = false;
  }
  return supported;
}

export function flag(iso2) {
  return canShowFlags() ? flagEmoji(iso2) : '';
}
