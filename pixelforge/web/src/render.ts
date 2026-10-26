/** 两级渲染：离屏 ImageData（网格分辨率）→ 最近邻拉伸到显示画布。
 *  M2.7：多图层栈自底向上合成单张位图；导航器已移除。 */

import { layerFillAt, layerInkAt, layerAlphaAt, docHasAlpha } from "./store";
import type { EditorDoc } from "./store";

export interface DocBitmap {
  canvas: HTMLCanvasElement; // 网格分辨率合成位图
}

interface ComposeOpts {
  includeInk?: boolean;   // 默认 true（墨线并入文件层，可单独关闭供线稿分离）
  alphaAware?: boolean;   // 默认 true：按层 alpha 合成（上层透明露出下层）
  transparent?: boolean;  // 导出需要透明背景（无源 alpha 时回退边缘泛洪）
}

/** 自顶向下取首个可见墨线索引（-1 = 无）。 */
function cellInkIndex(doc: EditorDoc, i: number): number {
  let ink = -1;
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const v = layerInkAt(doc, layer, i);
    if (v >= 0) ink = v; // 顶层优先
  }
  return ink;
}

/** 单格最终合成色（fill 自顶优先 + 墨线按不透明度叠加）——整幅与实时补丁共用同一套算法。
 *  alphaAware=true 时按层 alpha 剔除（上层透明露出下层）；false 时忽略 alpha（旧不透明行为）。 */
function cellColor(
  doc: EditorDoc, i: number, includeInk: boolean, alphaAware: boolean,
): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 0;
  for (let k = doc.layers.length - 1; k >= 0; k--) {
    const layer = doc.layers[k];
    if (!layer.visible) continue;
    const f = layerFillAt(doc, layer, i);
    if (f < 0) continue;
    if (alphaAware && layerAlphaAt(doc, layer, i) <= 0) continue; // 上层透明 → 露出下层
    const c = doc.palette[f] ?? [255, 0, 255];
    r = c[0]; g = c[1]; b = c[2]; a = 255;
    break; // 顶层不透明，下层不再参与
  }
  if (includeInk && a === 255 && doc.inkVisible && doc.inkOpacity > 0) {
    const ink = cellInkIndex(doc, i);
    if (ink >= 0) {
      const c = doc.palette[ink] ?? [0, 0, 0];
      const op = doc.inkOpacity;
      r = Math.round(c[0] * op + r * (1 - op));
      g = Math.round(c[1] * op + g * (1 - op));
      b = Math.round(c[2] * op + b * (1 - op));
    }
  }
  return [r, g, b, a];
}

/** 实时笔迹：把变更格的最新合成色补丁进缓存位图（无缓存则跳过，随后整幅重建兜底）。 */
export function patchBitmapCells(doc: EditorDoc, cells: Iterable<number>): void {
  const cache = (doc as EditorDoc & { _bitmaps?: DocBitmap })._bitmaps;
  if (!cache) return;
  const ctx = cache.canvas.getContext("2d")!;
  const px = ctx.createImageData(1, 1);
  for (const i of cells) {
    const [r, g, b, a] = cellColor(doc, i, true, true);
    px.data[0] = r; px.data[1] = g; px.data[2] = b; px.data[3] = a;
    ctx.putImageData(px, i % doc.w, Math.floor(i / doc.w));
  }
}

/** 边缘泛洪去底：背景色 = 边缘格中占比最高的有效色，从边缘连通同色区 alpha=0。
 *  M5-0 起仅在无源 alpha 信息时作为回退（非透明素材行为不变）。 */
function edgeFloodAlpha(data: Uint8ClampedArray, w: number, h: number): void {
  const colorKey = (i: number): string =>
    data[i * 4 + 3] === 0 ? "" : `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]}`;
  const borderCount = new Map<string, number>();
  const push = (x: number, y: number) => {
    const key = colorKey(y * w + x);
    if (key) borderCount.set(key, (borderCount.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { push(0, y); push(w - 1, y); }
  let bgKey = "";
  let best = 0;
  for (const [key, n] of borderCount) if (n > best) { best = n; bgKey = key; }
  if (!bgKey) return;
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  const seed = (x: number, y: number) => {
    const i = y * w + x;
    if (!visited[i] && colorKey(i) === bgKey) { visited[i] = 1; queue.push(i); }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { seed(0, y); seed(w - 1, y); }
  while (queue.length) {
    const i = queue.pop()!;
    data[i * 4 + 3] = 0; // 轮廓外透明
    const x = i % w, y = Math.floor(i / w);
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      seed(nx, ny);
    }
  }
}

/** 把文档图层栈合成为网格分辨率 ImageData。 */
function renderImageData(
  doc: EditorDoc, w: number, h: number, opts: ComposeOpts,
): ImageData {
  const img = new ImageData(w, h);
  const data = img.data;
  const includeInk = opts.includeInk ?? true;
  const transparent = !!opts.transparent;
  const alphaAware = opts.alphaAware ?? true;

  for (let i = 0; i < w * h; i++) {
    const [r, g, b, a] = cellColor(doc, i, includeInk, alphaAware);
    const k = i * 4;
    data[k] = r;
    data[k + 1] = g;
    data[k + 2] = b;
    data[k + 3] = a;
  }

  // 透明导出：有源 alpha/手动抠除 → 真 alpha（已在 data 中）；否则回退边缘泛洪
  if (transparent && !docHasAlpha(doc)) edgeFloodAlpha(data, w, h);
  return img;
}

/** 文档合成画布（导出共用入口）。
 *  transparent=true：有源 alpha 时输出真 alpha，否则边缘泛洪去底；
 *  transparent=false：忽略 alpha，输出不透明（复现旧行为）。 */
export function compositeDoc(doc: EditorDoc, opts: ComposeOpts = {}): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = doc.w;
  c.height = doc.h;
  const ctx = c.getContext("2d")!;
  const transparent = !!opts.transparent;
  ctx.putImageData(renderImageData(doc, doc.w, doc.h, {
    includeInk: opts.includeInk ?? true,
    // 透明导出按 alpha 合成（真 alpha 或边缘泛洪）；不透明导出忽略 alpha（复现旧行为）
    alphaAware: transparent,
    transparent,
  }), 0, 0);
  return c;
}

/** 索引网格（M5-1 索引 PNG 导出）：每格 = 最上层不透明层的调色板索引；
 *  alphaAware 时透明格记 -1（导出带 tRNS），墨线可见且有色则用墨线色索引。
 *  与 cellColor 同一套层栈规则，但只输出索引、不做混色。 */
export function composeIndexGrid(doc: EditorDoc, alphaAware: boolean): Int32Array {
  const out = new Int32Array(doc.w * doc.h).fill(-1);
  const inkOn = doc.inkVisible && doc.inkOpacity > 0;
  for (let i = 0; i < out.length; i++) {
    let idx = -1;
    for (let k = doc.layers.length - 1; k >= 0; k--) {
      const l = doc.layers[k];
      if (!l.visible) continue;
      const f = layerFillAt(doc, l, i);
      if (f < 0) continue;
      if (alphaAware && layerAlphaAt(doc, l, i) <= 0) continue;
      idx = f;
      break;
    }
    if (idx < 0) continue;
    if (inkOn) {
      const ink = cellInkIndex(doc, i);
      if (ink >= 0) idx = ink;
    }
    out[i] = idx;
  }
  return out;
}

/** 线稿独立画布：仅墨线有色、其余透明（不受「线」叠加开关影响）；无墨线返回 null。 */
export function compositeLineart(doc: EditorDoc): HTMLCanvasElement | null {
  const c = document.createElement("canvas");
  c.width = doc.w;
  c.height = doc.h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(doc.w, doc.h);
  let any = false;
  for (let i = 0; i < doc.w * doc.h; i++) {
    const ink = cellInkIndex(doc, i);
    if (ink < 0) continue;
    any = true;
    const col = doc.palette[ink] ?? [0, 0, 0];
    const k = i * 4;
    img.data[k] = col[0];
    img.data[k + 1] = col[1];
    img.data[k + 2] = col[2];
    img.data[k + 3] = 255;
  }
  if (!any) return null;
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 取文档合成位图（按文档缓存；失效由 invalidateBitmaps/patchBitmapCells 显式管理）。
 *  编辑器显示按 alpha 合成（透明格露出棋盘格底），不做边缘泛洪。 */
export function buildBitmaps(doc: EditorDoc): DocBitmap {
  const cache = (doc as EditorDoc & { _bitmaps?: DocBitmap })._bitmaps;
  if (cache && cache.canvas.width === doc.w && cache.canvas.height === doc.h) return cache;
  const c = document.createElement("canvas");
  c.width = doc.w;
  c.height = doc.h;
  c.getContext("2d")!.putImageData(
    renderImageData(doc, doc.w, doc.h, { includeInk: true, alphaAware: true }), 0, 0);
  const result = { canvas: c };
  (doc as EditorDoc & { _bitmaps?: DocBitmap })._bitmaps = result;
  return result;
}

export function invalidateBitmaps(doc: EditorDoc): void {
  delete (doc as EditorDoc & { _bitmaps?: DocBitmap })._bitmaps;
}

export interface RenderOptions {
  zoom: number;
  showGrid: boolean;
  compare: boolean;
  sourceImg: HTMLImageElement | null;
  lineartImg?: HTMLImageElement | null; // 线稿文档的源分辨率图（连续图像，非像素网格）
  underlay?: number; // 描图底图不透明度 0-1（源图垫在图层下方，透明格可见）
  selection?: import("./store").Selection | null;
  detailMask?: Set<number> | null; // M4：细节重算标记（橙色半透明覆盖）
}

export function renderView(
  canvas: HTMLCanvasElement,
  doc: EditorDoc,
  opts: RenderOptions,
): void {
  // 线稿文档：源分辨率连续图像，平滑缩放，不画像素网格/选区
  if (doc.lineart) {
    const z = Math.max(0.05, opts.zoom);
    const maxSide = 4096; // 背板上限：超大源图按比例缩到 ≤4096，再交给 CSS 平滑缩放
    const backScale = Math.min(1, maxSide / Math.max(doc.w, doc.h));
    const bw = Math.max(1, Math.round(doc.w * backScale));
    const bh = Math.max(1, Math.round(doc.h * backScale));
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.width = `${Math.round(doc.w * z)}px`;
    canvas.style.height = `${Math.round(doc.h * z)}px`;
    canvas.style.imageRendering = "auto"; // 覆盖像素画的 pixelated
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, bw, bh);
    if (opts.compare && opts.sourceImg) {
      ctx.drawImage(opts.sourceImg, 0, 0, bw, bh);
      return;
    }
    if (opts.lineartImg && opts.lineartImg.complete && opts.lineartImg.naturalWidth) {
      ctx.drawImage(opts.lineartImg, 0, 0, bw, bh);
    }
    return;
  }
  canvas.style.imageRendering = ""; // 恢复 CSS 的 pixelated（像素画）
  const z = Math.max(1, Math.round(opts.zoom));
  canvas.width = doc.w * z;
  canvas.height = doc.h * z;
  // 显式像素尺寸：绝不让 CSS 压缩画布（非整数缩放会丢行/列，产生"像素空格"假象）
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  if (opts.compare && opts.sourceImg) {
    ctx.drawImage(opts.sourceImg, 0, 0, canvas.width, canvas.height);
    return;
  }

  if (opts.underlay && opts.underlay > 0 && opts.sourceImg) {
    ctx.globalAlpha = Math.min(1, opts.underlay);
    ctx.drawImage(opts.sourceImg, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
  }
  ctx.drawImage(buildBitmaps(doc).canvas, 0, 0, canvas.width, canvas.height);

  // 细节重算标记：橙色半透明格（仅标记，不改像素）
  if (opts.detailMask?.size) {
    ctx.fillStyle = "rgba(255,150,40,.32)";
    for (const i of opts.detailMask) {
      ctx.fillRect((i % doc.w) * z, Math.floor(i / doc.w) * z, z, z);
    }
  }

  if (opts.showGrid && z >= 6) {
    ctx.strokeStyle = "rgba(128,128,128,.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < doc.w; x++) {
      ctx.moveTo(x * z + 0.5, 0);
      ctx.lineTo(x * z + 0.5, canvas.height);
    }
    for (let y = 1; y < doc.h; y++) {
      ctx.moveTo(0, y * z + 0.5);
      ctx.lineTo(canvas.width, y * z + 0.5);
    }
    ctx.stroke();
  }

  // 选区：矩形虚线框 / 多边形淡填充+虚线路径（蚂蚁线双描边）
  const sel = opts.selection;
  if (sel?.kind === "rect") {
    const r = sel.rect;
    dashRect(ctx, r.x0 * z + 0.5, r.y0 * z + 0.5,
      (r.x1 - r.x0 + 1) * z - 1, (r.y1 - r.y0 + 1) * z - 1, 0);
    dashRect(ctx, r.x0 * z + 0.5, r.y0 * z + 0.5,
      (r.x1 - r.x0 + 1) * z - 1, (r.y1 - r.y0 + 1) * z - 1, 4);
  } else if (sel?.kind === "poly") {
    if (sel.cells.size) {
      ctx.fillStyle = "rgba(255,255,255,.14)";
      for (const i of sel.cells) {
        ctx.fillRect((i % doc.w) * z, Math.floor(i / doc.w) * z, z, z);
      }
    }
    if (sel.path.length > 1) {
      ctx.lineWidth = 1;
      for (const [color, off] of [["rgba(255,255,255,.9)", 0], ["rgba(0,0,0,.6)", 4]] as const) {
        ctx.strokeStyle = color;
        ctx.setLineDash([4, 3]);
        ctx.lineDashOffset = off;
        ctx.beginPath();
        sel.path.forEach(([x, y], k) => {
          const px = (x + 0.5) * z, py = (y + 0.5) * z;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        if (sel.cells.size) ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  }
}

function dashRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, off: number,
): void {
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.lineDashOffset = off;
  ctx.strokeStyle = off === 0 ? "rgba(255,255,255,.9)" : "rgba(0,0,0,.6)";
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}