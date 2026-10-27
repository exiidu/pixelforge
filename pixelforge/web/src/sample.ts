/** A2 示例项目：用代码画一张 32×32 像素风景，不依赖任何外部图片。
 *
 * 这样示例可随发行版分发（无第三方素材版权问题），也不用把测试图片打进仓库。
 * 空白画布文档 + 自带调色板，打开后可直接手改/导出。
 */
import { addDoc, getState, mkLayer, presetRecipe, setActive, setState } from "./store";
import { ZERO_PALETTE_FX } from "./color";

const W = 32;
const H = 32;

const SKY = 0;
const NAVY = 1;
const SUN = 2;
const GRASS = 3;
const DARK_GRASS = 4;
const TRUNK = 5;
const WHITE = 6;
const RED = 7;

const PALETTE: [number, number, number][] = [
  [0x29, 0xad, 0xff], // 天空
  [0x1d, 0x2b, 0x53], // 山体 / 轮廓
  [0xff, 0xec, 0x27], // 太阳
  [0x00, 0xe4, 0x36], // 草地
  [0x00, 0x87, 0x51], // 深草 / 树冠
  [0xab, 0x52, 0x36], // 树干
  [0xff, 0xf1, 0xe8], // 云 / 雪
  [0xff, 0x00, 0x4d], // 花
];

const SAMPLE_NAME = "示例 · 像素风景";

function buildGrid(): Int32Array {
  const grid = new Int32Array(W * H).fill(SKY);
  const set = (x: number, y: number, color: number): void => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || ix >= W || iy < 0 || iy >= H) return;
    grid[iy * W + ix] = color;
  };
  const circle = (cx: number, cy: number, r: number, color: number): void => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) set(x, y, color);
      }
    }
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, color: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, color);
  };

  // 太阳 + 云
  circle(26, 6, 3.2, SUN);
  circle(6, 7, 2.2, WHITE);
  circle(9, 7.4, 2.6, WHITE);
  circle(11.5, 7, 1.7, WHITE);

  // 远山（带雪顶）
  for (let x = 2; x <= 25; x++) {
    const h = 11 - Math.abs(x - 13);
    if (h <= 0) continue;
    const top = 22 - h;
    for (let y = top; y <= 22; y++) set(x, y, y <= top + 1 ? WHITE : NAVY);
  }
  // 近山
  for (let x = 16; x <= 31; x++) {
    const h = Math.round(8 - Math.abs(x - 25) * 0.9);
    if (h <= 0) continue;
    const top = 23 - h;
    for (let y = top; y <= 23; y++) set(x, y, NAVY);
  }

  // 草地与土坡
  rect(0, 24, W - 1, H - 1, GRASS);
  rect(0, 24, W - 1, 24, DARK_GRASS);
  for (let x = 0; x < W; x += 5) set(x, 27, DARK_GRASS);

  // 树：树干 + 树冠高光
  rect(5, 24, 6, 29, TRUNK);
  circle(5.5, 22, 3.4, DARK_GRASS);
  circle(4.5, 21, 1.3, GRASS);
  circle(7.5, 21.5, 1.1, GRASS);

  // 小花
  set(21, 26, RED);
  set(23, 27, RED);
  set(26, 26, WHITE);
  set(28, 28, SUN);

  return grid;
}

/** 打开内置示例项目；已存在时直接切过去，避免重复开标签。 */
export function openSampleProject(): void {
  const existing = getState().docs.findIndex((d) => d.name === SAMPLE_NAME);
  if (existing >= 0) {
    setActive(existing);
    return;
  }
  const layer = mkLayer("画布层", "canvas");
  addDoc({
    name: SAMPLE_NAME,
    jobId: "",
    w: W,
    h: H,
    palette: PALETTE,
    paletteBase: PALETTE,
    paletteFx: { ...ZERO_PALETTE_FX },
    recipe: presetRecipe("photo"),
    presetName: "photo",
    fill: buildGrid(),
    ink: null,
    alpha: null,
    inkVisible: true,
    inkOpacity: 1,
    layers: [layer],
    activeLayerId: layer.id,
    baseLayerId: layer.id,
    sourceUrl: "",
    colorsUsed: PALETTE.length,
    ms: 0,
    blank: true,
  });
  setState({ zoom: 12, colorIndex: NAVY });
}
