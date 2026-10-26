/** 颜色数学：HSL/HSV/伽马亮度（调色板排序与颜色库共用）。 */

export function rgb2hsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

/** 伽马校正（线性光）相对亮度 0-1。 */
export function gammaLum([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().replace("#", "");
  if (/^[0-9a-fA-F]{3}$/.test(m)) {
    return m.split("").map((c) => parseInt(c + c, 16)) as [number, number, number];
  }
  if (/^[0-9a-fA-F]{6}$/.test(m)) {
    return [0, 2, 4].map((k) => parseInt(m.slice(k, k + 2), 16)) as [number, number, number];
  }
  return null;
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------ OKLab（色板变换用，M3） */
export type RGB = [number, number, number];
/** 色板变换参数：明度偏移 ±0.3、色相旋转 ±180°、饱和度倍率 0–2。 */
export interface PaletteFx { lightness: number; hue: number; saturation: number }
export const ZERO_PALETTE_FX: PaletteFx = { lightness: 0, hue: 0, saturation: 0 };

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

export function rgbToOklab([r, g, b]: RGB): [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

export function oklabToRgb([L, a, b]: [number, number, number]): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

/** 整板变换：格子的索引不动，只重生成颜色（改板不改画）。 */
export function transformPalette(pal: RGB[], fx: PaletteFx): RGB[] {
  if (!fx.lightness && !fx.hue && !fx.saturation) return pal;
  return pal.map((rgb) => {
    const [L, a, b] = rgbToOklab(rgb);
    const L2 = Math.max(0, Math.min(1, L + fx.lightness * 0.3));
    const h = Math.atan2(b, a) + (fx.hue * Math.PI) / 180;
    const c = Math.hypot(a, b) * Math.max(0, 1 + fx.saturation);
    return oklabToRgb([L2, Math.cos(h) * c, Math.sin(h) * c]);
  });
}
