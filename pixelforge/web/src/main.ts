/** PixelForge 编辑器 M1 装配：打开→转换→渲染，多文档标签，缩放/网格/对比。M2.7 图层栈。 */

import "./styles/main.css";
import { convertFile, convertPath, extractLineartFile, extractLineartPath, health, rerunRegion, exportIndexed,
  type ConvertResponse, type LineartResponse, type RerunRegionResponse } from "./api";
import { compositeDoc, compositeLineart, renderView, invalidateBitmaps, patchBitmapCells, composeIndexGrid } from "./render";
import {
  activeDoc, addDoc, getState, setState, subscribe, hexOf, updateDoc, mkLayer, presetRecipe, setActive,
  type RecipeParams, type EditorDoc, type PFLayer, type CellOverride, type PaletteSort,
  type LineartAsset,
} from "./store";
import { mountLayers, mountPalette, mountTabs, mountTools, mountHistory, mountColorLib } from "./panels";
import { mountMcpUi, setAgentControl, openMcpManager, getMcpAgents } from "./mcp-ui";
import { mountJobSync, type JobWsPayload } from "./job-sync";
import { mountSettings, getSettings, openSettings } from "./settings";
import { mountHelp } from "./help";
import { mountOnboarding } from "./onboarding";
import { openSampleProject } from "./sample";
import { mountDialogs, confirmDialog } from "./dialogs";
import { getLocale, t } from "./i18n";
import { putSource, getSource, clearSources } from "./source-store";
import { bucketFill, flipSelection, finishMove, copySelectionToOffset, paintCells, pixelPerfectLine, brushTipCells,
  shapeCells, shapePreviewApply, shapePreviewEnd, magneticSnap, polygonCells,
  beginStroke, endStroke, stampCells, redo, undo, compositeFill, ensureDocColor,
  extractSelectionToLayer, deleteLayer, scopeHas, commitBasePatch, magicAlphaErase,
  setPaletteColor, setPaletteBaseWithRemap } from "./tools";
import { rgbToHex, transformPalette, ZERO_PALETTE_FX, type PaletteFx } from "./color";

declare const __APP_VERSION__: string;

/** 两格间的 Bresenham 线（磁力套索路径插值）。 */
function plainLineBetween(a: [number, number], b: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let dx = Math.abs(b[0] - a[0]), dy = -Math.abs(b[1] - a[1]);
  const sx = a[0] < b[0] ? 1 : -1, sy = a[1] < b[1] ? 1 : -1;
  let err = dx + dy, x = a[0], y = a[1];
  for (;;) {
    out.push([x, y]);
    if (x === b[0] && y === b[1]) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return out;
}

/** 方向键移动选区内容（copy=复制） */
function moveSelectionBy(doc: import("./store").EditorDoc, dx: number, dy: number, copy: boolean): void {
  if (copy) copySelectionToOffset(doc, dx, dy);
  else finishMove(doc, dx, dy);
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $("canvas") as HTMLCanvasElement;
const wrap = $("canvaswrap");
const emptyHint = $("empty");
const sourceCache = new Map<string, HTMLImageElement>(); // jobId/线稿文档 id → 源图缩略
const lineartImageCache = new Map<string, HTMLImageElement>(); // doc.id → 源分辨率线稿图

/** 源图缓存键：线稿文档没有引擎 job，用文档 id 区分。 */
function sourceKey(doc: EditorDoc): string {
  return doc.lineart ? `la:${doc.id}` : doc.jobId;
}

/** 取线稿文档的源分辨率图（异步加载，加载完成自动重绘）。 */
function ensureLineartImage(doc: EditorDoc): HTMLImageElement | null {
  if (!doc.lineart) return null;
  const cached = lineartImageCache.get(doc.id);
  if (cached && cached.src === doc.lineart.url) return cached;
  const img = new Image();
  img.onload = () => {
    if (lineartImageCache.get(doc.id) === img) redrawCanvas();
  };
  img.src = doc.lineart.url;
  lineartImageCache.set(doc.id, img);
  return img;
}

function dropLineartImage(docId: string): void {
  lineartImageCache.delete(docId);
}

function fitZoomFor(w: number, h: number): number {
  const pad = 40;
  const cw = wrap.clientWidth - pad;
  const ch = wrap.clientHeight - pad;
  if (cw <= 0 || ch <= 0) return 1;
  return Math.max(1, Math.min(24, Math.floor(Math.min(cw / w, ch / h))));
}

/** 线稿是连续图像：允许分数缩放，打开时最多 100%（不放大）。 */
function fitZoomForLineart(w: number, h: number): number {
  const pad = 40;
  const cw = wrap.clientWidth - pad;
  const ch = wrap.clientHeight - pad;
  if (cw <= 0 || ch <= 0) return 1;
  return Math.max(0.05, Math.min(1, cw / w, ch / h));
}

/* ------------------------------------------------ M5-0 真透明与主体分离 */

/** 网格 alpha 灰度 PNG → 0/1 位图（长度 w*h）。 */
function decodeAlphaPng(pngB64: string, w: number, h: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const out = new Uint8Array(w * h);
      for (let i = 0; i < out.length; i++) out[i] = px[i * 4] >= 128 ? 1 : 0;
      resolve(out);
    };
    img.onerror = () => reject(new Error("alpha 蒙版解码失败"));
    img.src = `data:image/png;base64,${pngB64}`;
  });
}

function alphaHasTransparent(a: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (!a[i]) return true;
  return false;
}

/** 边缘主色（不透明边缘格中出现最多的调色板索引）；边缘全透明时退化为全局主色。 */
function edgeDominantIndex(fill: Int32Array, alpha: Uint8Array, w: number, h: number): number {
  const tally = new Map<number, number>();
  const add = (i: number) => { if (alpha[i]) tally.set(fill[i], (tally.get(fill[i]) ?? 0) + 1); };
  for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { add(y * w); add(y * w + w - 1); }
  let idx = -1, best = -1;
  for (const [k, n] of tally) if (n > best) { best = n; idx = k; }
  if (idx < 0) {
    const t2 = new Map<number, number>();
    for (let i = 0; i < alpha.length; i++) if (alpha[i]) t2.set(fill[i], (t2.get(fill[i]) ?? 0) + 1);
    for (const [k, n] of t2) if (n > best) { best = n; idx = k; }
  }
  return Math.max(0, idx);
}

/** 自动拆分：透明格补「边缘主色」建背景层（默认隐藏=真透明，可恢复/删除）。 */
function makeBackgroundLayer(fill: Int32Array, alpha: Uint8Array, w: number, h: number): PFLayer | null {
  if (!alphaHasTransparent(alpha)) return null;
  const idx = edgeDominantIndex(fill, alpha, w, h);
  const bg = mkLayer("背景层", "normal");
  bg.bg = true;
  bg.visible = false;
  for (let i = 0; i < alpha.length; i++) if (!alpha[i]) bg.data.set(i, { fill: idx });
  return bg;
}

/** 组装内容层栈：画布层（底）→ [背景层] → 文件层（base，顶）。 */
function buildLayers(fill: Int32Array, alpha: Uint8Array | null, w: number, h: number):
  { layers: PFLayer[]; fileLayer: PFLayer } {
  const fileLayer = mkLayer("文件层", "file");
  const layers: PFLayer[] = [mkLayer("画布层", "canvas")];
  const bg = alpha ? makeBackgroundLayer(fill, alpha, w, h) : null;
  if (bg) layers.push(bg);
  layers.push(fileLayer);
  return { layers, fileLayer };
}

/** 重转换后刷新自动背景层（透明格补边缘主色）；源已无透明信息则移除该层。 */
function refreshBackgroundLayer(doc: EditorDoc): void {
  const bg = doc.layers.find((l) => l.bg);
  if (!bg) return;
  if (!doc.alpha || !alphaHasTransparent(doc.alpha)) {
    doc.layers = doc.layers.filter((l) => l !== bg);
    if (doc.activeLayerId === bg.id) doc.activeLayerId = doc.baseLayerId;
    return;
  }
  const idx = edgeDominantIndex(doc.fill, doc.alpha, doc.w, doc.h);
  bg.data.clear();
  for (let i = 0; i < doc.alpha.length; i++) if (!doc.alpha[i]) bg.data.set(i, { fill: idx });
}

/** MCP-3B：把服务端 job 的 revision 更新应用到同 jobId 的文档；本地手改层保持在上层。 */
let agentToastTimer = 0;
let lastJobUpdate: { jobId: string; name: string; revision: number; action: string } | null = null;
function showAgentToast(text: string): void {
  let el = document.getElementById("agent-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "agent-toast";
    el.className = "pf-toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  window.clearTimeout(agentToastTimer);
  agentToastTimer = window.setTimeout(() => el?.remove(), 8000);
}

async function applyJobUpdate(doc: EditorDoc, update: JobWsPayload): Promise<void> {
  if (doc.lineart || update.job_id !== doc.jobId) return;
  if (update.width !== doc.w || update.height !== doc.h) {
    setStatus(`Agent 更新尺寸不匹配（${update.width}×${update.height}），已忽略`);
    return;
  }
  if (doc.jobRevision != null && update.revision <= doc.jobRevision) return;

  const alpha = update.alpha_png
    ? await decodeAlphaPng(update.alpha_png, update.width, update.height)
    : null;
  if (doc.jobId !== update.job_id) return; // 解码期间文档已重转换到新 job

  const fill = Int32Array.from(update.fill.flat());
  const ink = update.ink ? Int32Array.from(update.ink.flat()) : null;
  const paletteBase = update.palette;
  invalidateBitmaps(doc);
  updateDoc(doc, {
    fill,
    ink,
    alpha,
    paletteBase,
    palette: transformPalette(paletteBase, doc.paletteFx),
    jobRevision: update.revision,
    colorsUsed: new Set(Array.from(fill)).size,
    dirty: true,
  });
  refreshBackgroundLayer(doc);
  invalidateBitmaps(doc);
  redrawCanvas();
  const action = update.action || "编辑";
  lastJobUpdate = { jobId: update.job_id, name: doc.name, revision: update.revision, action };
  const badge = $<HTMLElement>("agent-sync");
  badge.hidden = false;
  badge.textContent = `Agent · ${doc.name} · rev ${update.revision}`;
  setStatus(`Agent 更新 ${doc.name} · ${action}`);
  if (getSettings().agentNotifications) showAgentToast(`Agent 更新 ${doc.name} · ${action}`);
}

async function docFromResponse(
  name: string,
  r: ConvertResponse,
  src?: { file?: File; path?: string },
  recipe: RecipeParams = presetRecipe(getState().preset),
  presetName: string = getState().preset,
): Promise<EditorDoc> {
  const alpha = r.alpha_png ? await decodeAlphaPng(r.alpha_png, r.width, r.height) : null;
  const fill = Int32Array.from(r.fill.flat());
  const { layers, fileLayer } = buildLayers(fill, alpha, r.width, r.height);
  const doc = addDoc({
    name,
    jobId: r.job_id,
    jobRevision: r.revision ?? 0,
    w: r.width,
    h: r.height,
    palette: r.palette,
    paletteBase: r.palette,
    paletteFx: { ...ZERO_PALETTE_FX },
    recipe: { ...recipe },
    presetName,
    fill,
    ink: r.ink ? Int32Array.from(r.ink.flat()) : null,
    alpha,
    inkVisible: true,
    inkOpacity: 1,
    layers, // 画布层在最底，[背景层]，文件层（结构转换结果）在上
    activeLayerId: fileLayer.id,
    baseLayerId: fileLayer.id,
    sourceUrl: r.source_png ? `data:image/png;base64,${r.source_png}` : "",
    colorsUsed: r.meta.colors_used,
    ms: r.meta.grid_ms,
    src,
  });
  setState({ zoom: fitZoomFor(r.width, r.height) });
  cacheSource(r.job_id, r.source_png);
  return doc;
}

/** 线稿文档：源分辨率 PNG 直接显示，不建像素网格/图层/调色板。 */
function docFromLineartResponse(
  name: string,
  r: LineartResponse,
  src: { file?: File; path?: string },
  recipe: RecipeParams,
  presetName: string,
  ms = 0,
): EditorDoc {
  const doc = addDoc({
    name,
    lineart: { url: `data:image/png;base64,${r.png}`, width: r.width, height: r.height, mode: r.mode },
    jobId: "",
    w: r.width,
    h: r.height,
    palette: [],
    paletteBase: [],
    paletteFx: { ...ZERO_PALETTE_FX },
    recipe: { ...recipe },
    presetName,
    fill: new Int32Array(0),
    ink: null,
    alpha: null,
    inkVisible: false,
    inkOpacity: 1,
    layers: [],
    activeLayerId: "",
    baseLayerId: "",
    sourceUrl: r.source_png ? `data:image/png;base64,${r.source_png}` : "",
    colorsUsed: 0,
    ms,
    src,
  });
  setState({ zoom: fitZoomForLineart(r.width, r.height) });
  cacheSource(sourceKey(doc), r.source_png);
  return doc;
}

function cacheSource(key: string, png: string | null): void {
  if (!png) return;
  const img = new Image();
  img.onload = () => sourceCache.set(key, img);
  img.src = `data:image/png;base64,${png}`;
}

/* ---------------------------------------------------------------- 批量导入（M3） */

/** 把上传源文件落到 IndexedDB 并把 key 记到 doc.src（会话恢复后仍可重转换）。 */
async function persistSource(doc: EditorDoc, file: File): Promise<void> {
  const key = await putSource(file);
  if (key && doc.src) doc.src.key = key;
}

/** 导入统一应用「当前配方」：有活动文档时取它的配方，否则取预设默认。 */
function importCtx(): { presetName: string; recipe: RecipeParams } {
  const doc = activeDoc();
  if (doc && !doc.blank) return { presetName: doc.presetName, recipe: { ...doc.recipe } };
  return { presetName: getState().preset, recipe: presetRecipe(getState().preset) };
}

$("file-input").addEventListener("change", (e) => {
  const files = [...(e.target as HTMLInputElement).files ?? []];
  (e.target as HTMLInputElement).value = "";
  void importFiles(files, "打开图片");
});
$("folder-input").addEventListener("change", (e) => {
  const files = [...(e.target as HTMLInputElement).files ?? []];
  (e.target as HTMLInputElement).value = "";
  void importFiles(files, "打开文件夹");
});

/** 批量导入：逐个转换建档；坏文件跳过不中断，完成后汇总失败清单。 */
async function importFiles(all: File[], label: string): Promise<void> {
  const files = all
    .filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
    .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
  if (!files.length) { setStatus(`${label}：未找到支持的图片`); return; }
  const ctx = importCtx();
  const lineartMode = ctx.presetName === "lineart";
  const extractMode = ctx.recipe.lineart === "xdog" ? "xdog" : "onnx";
  const progd = $("progd") as HTMLDialogElement;
  const t0 = performance.now();
  const tick = (text: string) => {
    $("prog-text").textContent = text;
    $("prog-time").textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  };
  const timer = window.setInterval(() => {
    $("prog-time").textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);
  tick(`${lineartMode ? "正在提取线稿" : "正在导入"} 1/${files.length} · ${files[0].name}`);
  if (!progd.open) progd.showModal();
  const failed: string[] = [];
  let ok = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      tick(`${lineartMode ? "正在提取线稿" : "正在导入"} ${i + 1}/${files.length} · ${f.name}`);
      try {
        const name = f.name.replace(/\.[^.]+$/, "");
        if (lineartMode) {
          const t = performance.now();
          const r = await extractLineartFile(f, extractMode);
          const d = docFromLineartResponse(name, r, { file: f }, ctx.recipe, ctx.presetName,
            Math.round(performance.now() - t));
          await persistSource(d, f);
        } else {
          const r = await convertFile(f, ctx.presetName, getState().size, recipeOverrides(ctx.recipe));
          const d = await docFromResponse(name, r, { file: f }, ctx.recipe, ctx.presetName);
          await persistSource(d, f);
        }
        ok++;
      } catch (err) {
        failed.push(f.name);
        console.warn("导入失败", f.name, err);
      }
    }
  } finally {
    window.clearInterval(timer);
    if (progd.open) progd.close();
  }
  const failMsg = failed.length
    ? ` · 失败 ${failed.length}（${failed.slice(0, 3).join("、")}${failed.length > 3 ? "…" : ""}）`
    : "";
  setStatus(`${lineartMode ? "线稿提取完成" : "导入完成"} ${ok}/${files.length} 张${failMsg}`);
}

/* ------------------------------------------------ 预设/尺寸变更 → 重转换当前文档 */
let converting = false;

/** 配方参数 → 引擎 overrides（与预设在引擎侧深合并）。 */
function recipeOverrides(r: import("./store").RecipeParams): Record<string, unknown> {
  return {
    preprocess: { levels: { bright_contrast: r.brightContrast } }, // M5.3 亮部对比（自适应，只动亮区）
    sampling: {
      weights: { edge: r.edge, dark: r.dark, contrast: r.contrast },
      soft_ratio: r.softRatio,
      merge_delta: r.mergeDelta,
    },
    quantize: {
      palette: r.paletteSource === "builtin"
        ? { source: "builtin", ref: r.paletteRef }
        : {
            source: "extract", max_colors: r.maxColors,
            // M5-4 色板锁定：重转换时强制保留的锁定色（引擎侧从提取预算扣减并追加到尾部）
            seed_colors: r.paletteLock ? r.seedColors : [],
          },
    },
    structure: { lineart: { mode: r.lineart } },
    ink: { enable: r.ink },
  };
}

/** 线稿文档重提取（预设=线稿）：源分辨率连续图像，不建像素网格。 */
async function reconvertDocLineart(doc: EditorDoc): Promise<void> {
  if (!doc.src) {
    setStatus(`${doc.name} · 无源图，无法提取线稿`);
    if (doc === activeDoc()) void offerRelocateSource(doc);
    return;
  }
  if (converting) return;
  converting = true;
  setStatus(`提取线稿… ${doc.name}`);
  const progd = $("progd") as HTMLDialogElement;
  $("prog-text").textContent = `正在提取线稿 ${doc.name}`;
  const t0 = performance.now();
  const progTimer = window.setInterval(() => {
    $("prog-time").textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);
  if (!progd.open) progd.showModal();
  try {
    const mode = doc.recipe.lineart === "xdog" ? "xdog" : "onnx";
    const r = doc.src.file
      ? await extractLineartFile(doc.src.file, mode)
      : await extractLineartPath(doc.src.path!, mode);
    const ms = Math.round(performance.now() - t0);
    dropLineartImage(doc.id);
    updateDoc(doc, {
      lineart: { url: `data:image/png;base64,${r.png}`, width: r.width, height: r.height, mode: r.mode },
      w: r.width,
      h: r.height,
      palette: [],
      paletteBase: [],
      paletteFx: { ...ZERO_PALETTE_FX },
      fill: new Int32Array(0),
      ink: null,
      inkVisible: false,
      inkOpacity: 1,
      layers: [],
      activeLayerId: "",
      baseLayerId: "",
      sourceUrl: r.source_png ? `data:image/png;base64,${r.source_png}` : "",
      colorsUsed: 0,
      ms,
      history: { undo: [], redo: [] },
      _palBefore: undefined,
    });
    setState({ selection: null, colorIndex: 0, zoom: fitZoomForLineart(r.width, r.height) });
    cacheSource(sourceKey(doc), r.source_png); // 此时 doc.lineart 已就位，键为文档 id
    redrawCanvas();
  } catch (err) {
    setStatus(`线稿提取失败 ${doc.name}: ${(err as Error).message}`);
  } finally {
    converting = false;
    window.clearInterval(progTimer);
    if (progd.open) progd.close();
  }
}

/** 重转换指定文档（参数面板改动/预设切换/应用到全部都走这里）。 */
async function reconvertDoc(doc: EditorDoc): Promise<void> {
  if (doc.blank) {
    setStatus(`${doc.name} · 空白画布，不参与转换`);
    return;
  }
  if (doc.presetName === "lineart") {
    await reconvertDocLineart(doc);
    return;
  }
  if (!doc.src) {
    setStatus(`${doc.name} · 无源图（会话恢复的上传文件），无法重转换`);
    if (doc === activeDoc()) void offerRelocateSource(doc);
    return;
  }
  if (converting) return;
  converting = true;
  setStatus(`转换中… ${doc.name}`);
  doc._palBefore = doc.paletteBase; // 供重放时做索引重绑（用未变换的原始板）
  // 进度弹窗（大网格转换数秒，给中央反馈）
  const progd = document.getElementById("progd") as HTMLDialogElement;
  const targetSize = getState().size;
  $("prog-text").textContent = `正在转换 ${doc.name} → ${targetSize}×${targetSize}`;
  const t0 = performance.now();
  const progTimer = window.setInterval(() => {
    $("prog-time").textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);
  if (!progd.open) progd.showModal();
  try {
    const { size } = getState();
    // M5-4：锁定开启时按当前色板刷新锁定色（语义 = "保留现在这套色"）
    if (doc.recipe.paletteLock && doc.paletteBase.length && doc.recipe.paletteSource === "extract") {
      doc.recipe = {
        ...doc.recipe,
        seedColors: doc.paletteBase.slice(0, 32).map((c) => [...c] as [number, number, number]),
      };
    }
    const ov = recipeOverrides(doc.recipe);
    const r = doc.src.file
      ? await convertFile(doc.src.file, doc.presetName, size, ov)
      : await convertPath(doc.src.path!, doc.presetName, size, ov);
    const fromLineart = !!doc.lineart;
    const dimsChanged = r.width !== doc.w || r.height !== doc.h;
    const oldW = doc.w, oldH = doc.h;
    const alpha = r.alpha_png ? await decodeAlphaPng(r.alpha_png, r.width, r.height) : null;
    const newFill = Int32Array.from(r.fill.flat());
    invalidateBitmaps(doc); // 先失效缓存：updateDoc 触发的重绘按新数据重建

    if (fromLineart) {
      // 线稿 → 像素画：重建网格图层栈与历史（线稿没有手改可重放）
      dropLineartImage(doc.id);
      const { layers, fileLayer } = buildLayers(newFill, alpha, r.width, r.height);
      updateDoc(doc, {
        lineart: undefined,
        name: doc.name,
        jobId: r.job_id,
        jobRevision: r.revision ?? 0,
        w: r.width,
        h: r.height,
        palette: transformPalette(r.palette, doc.paletteFx),
        paletteBase: r.palette,
        fill: newFill,
        ink: r.ink ? Int32Array.from(r.ink.flat()) : null,
        alpha,
        inkVisible: true,
        inkOpacity: 1,
        layers,
        activeLayerId: fileLayer.id,
        baseLayerId: fileLayer.id,
        sourceUrl: r.source_png ? `data:image/png;base64,${r.source_png}` : "",
        colorsUsed: r.meta.colors_used,
        ms: r.meta.grid_ms,
        history: { undo: [], redo: [] },
        detailMask: new Set<number>(),
      });
      doc._palBefore = undefined;
      setState({ selection: null, colorIndex: 0, zoom: fitZoomFor(r.width, r.height) });
    } else {
      updateDoc(doc, {
        // 尺寸后缀只在首次建档时有意义，重转换后去掉避免名不副实
        name: dimsChanged ? doc.name.replace(/_\d+$/, "") : doc.name,
        jobId: r.job_id,
        jobRevision: r.revision ?? 0,
        w: r.width,
        h: r.height,
        palette: transformPalette(r.palette, doc.paletteFx),
        paletteBase: r.palette,
        fill: newFill,
        ink: r.ink ? Int32Array.from(r.ink.flat()) : null,
        alpha,
        sourceUrl: r.source_png ? `data:image/png;base64,${r.source_png}` : "",
        colorsUsed: r.meta.colors_used,
        ms: r.meta.grid_ms,
        ...(dimsChanged ? { detailMask: new Set<number>() } : {}),
      });
      if (dimsChanged) {
        // 网格变了：格号重映射（最近格）后按 OKLab 最近色重绑索引；超界丢弃
        replayOverrides(doc, oldW, oldH);
      } else {
        rebindPalette(doc, r.palette);
      }
      if (dimsChanged) setState({ zoom: fitZoomFor(r.width, r.height) });
    }
    refreshBackgroundLayer(doc); // 自动背景层随新 alpha/fill/色板刷新
    invalidateBitmaps(doc);
    cacheSource(r.job_id, r.source_png);
    redrawCanvas(); // 重放/重绑改动了手改层，收尾再绘一次保证显示与新数据一致
  } catch (err) {
    setStatus(`重转换失败 ${doc.name}: ${(err as Error).message}`);
  } finally {
    converting = false;
    window.clearInterval(progTimer);
    if (progd.open) progd.close();
  }
}

/** 参数改动生效：应用到全部开关打开时广播配方并逐个重转换，否则只转当前文档。 */
async function applyRecipeChange(presetName?: string): Promise<void> {
  const doc = activeDoc();
  if (!doc) return;
  if (!getState().applyAll) {
    await reconvertDoc(doc);
    return;
  }
  const preset = presetName ?? doc.presetName;
  const targets = getState().docs.filter((d) => !d.blank && d.src);
  for (const d of targets) {
    updateDoc(d, { recipe: { ...doc.recipe }, presetName: preset });
  }
  for (const d of targets) await reconvertDoc(d);
  redrawCanvas();
  setStatus(`已应用配方到 ${targets.length} 个文档`);
}

function setStatus(text: string): void {
  $("stat-doc").textContent = text;
}

/* ------------------------------------------------ M4 细节增强（区域重算） */
/** 强度档：权重倍率 / 软边与合并阈值收紧 / 区域追加色上限。 */
const DETAIL_LEVELS = [
  { extra: 4, edge: 1.2, dark: 1.1, soft: 0.9, merge: 0.8 },
  { extra: 8, edge: 1.5, dark: 1.25, soft: 0.8, merge: 0.6 },
  { extra: 12, edge: 2.0, dark: 1.5, soft: 0.7, merge: 0.4 },
];

/** 标记 → 网格尺寸黑白蒙版 PNG（白=重算）。 */
function detailMaskPng(doc: EditorDoc): string {
  const cv = document.createElement("canvas");
  cv.width = doc.w;
  cv.height = doc.h;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, doc.w, doc.h);
  ctx.fillStyle = "#fff";
  for (const i of doc.detailMask ?? []) {
    ctx.fillRect(i % doc.w, Math.floor(i / doc.w), 1, 1);
  }
  return cv.toDataURL("image/png").split(",")[1];
}

/** 局部细节重算：只写回标记格；色板前缀不动（可尾部追加）；整笔可撤销。 */
async function rerunDetailRegion(): Promise<void> {
  const doc = activeDoc();
  if (!doc) return;
  if (doc.blank || !doc.src) {
    setStatus("空白画布 / 无源图文档不支持细节重算");
    return;
  }
  if (!doc.detailMask?.size) {
    setStatus("先用「细节」笔刷标记要重算的区域");
    return;
  }
  const cells = [...doc.detailMask].sort((a, b) => a - b);
  const level = DETAIL_LEVELS[Math.max(0, Math.min(2, getState().detailLevel))];
  const r = doc.recipe;
  const delta = {
    sampling: {
      weights: { edge: r.edge * level.edge, dark: r.dark * level.dark, contrast: r.contrast },
      soft_ratio: Math.min(4, Math.max(0.4, r.softRatio * level.soft)),
      merge_delta: Math.max(0, r.mergeDelta * level.merge),
    },
  };
  setStatus(`细节重算中… ${doc.name}（${cells.length} 格）`);
  try {
    let resp: RerunRegionResponse;
    try {
      resp = await rerunRegion(doc.jobId, detailMaskPng(doc), delta, level.extra);
    } catch (err) {
      if (!String((err as Error).message).includes("404")) throw err;
      // 引擎重启 / 会话恢复后 job 失效：全量重转换换新 job 再重试一次
      const oldW = doc.w, oldH = doc.h;
      await reconvertDoc(doc);
      if (doc.w !== oldW || doc.h !== oldH) {
        setStatus("重转换后网格尺寸变化，细节标记已失效，请重新标记");
        return;
      }
      resp = await rerunRegion(doc.jobId, detailMaskPng(doc), delta, level.extra);
    }
    // 色板契约：旧索引前缀必须一致，否则中止（不写画布，保证可回滚）
    const palBefore = doc.paletteBase.map((c) => [...c] as [number, number, number]);
    const prefixOk = resp.palette.slice(0, palBefore.length).every(
      (c, i) => c[0] === palBefore[i][0] && c[1] === palBefore[i][1] && c[2] === palBefore[i][2],
    );
    if (!prefixOk) throw new Error("色板前缀不一致，已中止（请先重转换该文档）");

    const beforeFill = cells.map((i) => doc.fill[i]);
    const beforeInk = cells.map((i) => (doc.ink ? doc.ink[i] : null));
    const afterFill = cells.map((i) => resp.fill[Math.floor(i / doc.w)][i % doc.w]);
    for (let k = 0; k < cells.length; k++) doc.fill[cells[k]] = afterFill[k];
    if (resp.palette.length > doc.paletteBase.length) {
      doc.paletteBase = resp.palette.map((c) => [...c] as [number, number, number]);
      doc.palette = transformPalette(doc.paletteBase, doc.paletteFx);
    }
    const afterInk = cells.map((i) => (doc.ink ? doc.ink[i] : null));
    doc.detailMask = new Set();
    commitBasePatch(doc, "细节重算", {
      cells,
      beforeFill,
      afterFill,
      beforeInk,
      afterInk,
      paletteBefore: palBefore,
      paletteAfter: doc.paletteBase.map((c) => [...c] as [number, number, number]),
    });
    invalidateBitmaps(doc);
    redrawCanvas();
    setStatus(
      `细节重算完成 · ${cells.length} 格 · 改动 ${resp.meta.changed_cells} · ${resp.meta.region_ms}ms`
      + (resp.meta.appended_colors ? ` · +${resp.meta.appended_colors} 色` : ""),
    );
  } catch (err) {
    setStatus(`细节重算失败: ${(err as Error).message}`);
    redrawCanvas();
  }
}

/* ------------------------------------------------ 手改重放（重转换后保手改） */
/** 同尺寸重转换：调色板重排了 → 每个层的 override 索引按 OKLab 最近色重绑。 */
function rebindPalette(doc: import("./store").EditorDoc, newPal: [number, number, number][]): void {
  const oldPal = doc._palBefore ?? doc.paletteBase; // 无快照（新建画布）时板未变，恒等映射
  const nearest = (c: [number, number, number]) => {
    let best = 0, bd = Infinity;
    for (let k = 0; k < newPal.length; k++) {
      const p = newPal[k];
      const dr = c[0] - p[0], dg = c[1] - p[1], db = c[2] - p[2];
      const d = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  };
  const remap = new Map<number, number>();
  oldPal.forEach((c, k) => remap.set(k, nearest(c)));
  for (const layer of doc.layers) {
    for (const ov of layer.data.values()) {
      if (ov.fill !== undefined && ov.fill >= 0) ov.fill = remap.get(ov.fill) ?? 0;
      if (ov.ink !== undefined && ov.ink >= 0) ov.ink = remap.get(ov.ink) ?? 0;
    }
  }
  doc._palBefore = newPal; // 重绑后 override 语义已对应新板，链式基准前移
}

/** 跨尺寸重转换：所有层的格号最近格映射（索引重绑交给 rebindPalette）。 */
function replayOverrides(doc: import("./store").EditorDoc, oldW: number, oldH: number): void {
  const sx = doc.w / oldW, sy = doc.h / oldH;
  const conv = (i: number): number => {
    const x = i % oldW, y = Math.floor(i / oldW);
    return Math.min(doc.w - 1, Math.floor(x * sx)) + Math.min(doc.h - 1, Math.floor(y * sy)) * doc.w;
  };
  for (const layer of doc.layers) {
    const oldData = new Map(layer.data);
    layer.data.clear();
    for (const [i, ov] of oldData) layer.data.set(conv(i), { ...ov });
  }
  rebindPalette(doc, doc.paletteBase);
}

/* ---------------------------------------------------------------- 画布重绘 */
/** 源图缓存兜底：会话恢复后 jobId 已失效，用文档内嵌缩略图重建缓存。 */
function ensureSourceCached(doc: EditorDoc): HTMLImageElement | null {
  const key = sourceKey(doc);
  const hit = sourceCache.get(key);
  if (hit || !key || !doc.sourceUrl) return hit ?? null;
  const img = new Image();
  img.onload = () => {
    if (sourceCache.get(key) === img) redrawCanvas();
  };
  img.onerror = () => {
    if (sourceCache.get(key) === img) sourceCache.delete(key);
  };
  img.src = doc.sourceUrl;
  sourceCache.set(key, img);
  return img;
}

function redrawCanvas(): void {
  const doc = activeDoc();
  const { zoom, showGrid, compare, underlay } = getState();
  wrap.hidden = !doc;
  emptyHint.hidden = !!doc;
  wrap.classList.toggle("tool-hand", getState().tool === "hand");
  if (!doc) {
    // 无文档：清掉右侧栏残留（图层/调色板/状态）
    $("palette").replaceChildren();
    $("layers").replaceChildren();
    $("pal-count").textContent = "";
    $("stat-doc").textContent = "—";
    $("stat-cursor").textContent = "—";
    return;
  }
  renderView(canvas, doc, {
    zoom,
    showGrid,
    compare,
    sourceImg: ensureSourceCached(doc),
    lineartImg: ensureLineartImage(doc),
    underlay: underlay / 100,
    selection: getState().selection,
    detailMask: doc.detailMask,
  });
  $("zoom-v").textContent = `${Math.round(zoom * 100)}%`;
  setStatus(
    doc.lineart
      ? `${doc.name} · ${doc.w}×${doc.h} px · 线稿 ${doc.lineart.mode.toUpperCase()}${doc.ms ? ` · ${doc.ms}ms` : ""}`
      : doc.blank
        ? `${doc.name} · ${doc.w}×${doc.h} · 空白画布 ${doc.colorsUsed} 色`
        : `${doc.name} · ${doc.w}×${doc.h} · ${doc.colorsUsed} 色 · 网格 ${doc.ms}ms`,
  );
}

/* 文档数据被面板就地改动时（图层可见性等） */
document.addEventListener("doc-changed", () => {
  const doc = activeDoc();
  if (doc) invalidateBitmaps(doc);
  redrawCanvas();
});
document.addEventListener("pf:pick-color", ((e: CustomEvent<number>) => {
  setState({ colorIndex: e.detail });
}) as EventListener);
document.addEventListener("pf:undo", () => undo());
document.addEventListener("pf:redo", () => redo());
document.addEventListener("pf:status", ((e: CustomEvent<string>) => setStatus(e.detail)) as EventListener);
document.addEventListener("pf:lib-pick", ((e: CustomEvent<{ rgb: [number, number, number] }>) => {
  const doc = activeDoc();
  if (doc) setState({ colorIndex: ensureDocColor(doc, e.detail.rgb) });
}) as EventListener);
document.addEventListener("pf:custom-color", ((e: CustomEvent<{ rgb: [number, number, number] }>) => {
  const rgb = e.detail.rgb;
  const hex = rgbToHex(rgb);
  const customs = [hex, ...getState().customColors.filter((c) => c !== hex)].slice(0, 20);
  setState({ customColors: customs });
  const doc = activeDoc();
  if (doc) setState({ colorIndex: ensureDocColor(doc, rgb) });
}) as EventListener);
/* M5-3：用颜色库当前色替换文档调色板的当前索引（索引/画布不动，可撤销） */
document.addEventListener("pf:replace-color", ((e: CustomEvent<{ rgb: [number, number, number] }>) => {
  const doc = activeDoc();
  if (!doc) return;
  const k = getState().colorIndex;
  if (k < 0 || k >= doc.paletteBase.length) { setStatus("请先选一个文档颜色"); return; }
  const hex = rgbToHex(e.detail.rgb);
  if (setPaletteColor(doc, k, e.detail.rgb, "替换颜色")) {
    invalidateBitmaps(doc);
    redrawCanvas();
    setStatus(`已把索引 ${k} 替换为 ${hex}（可撤销）`);
  } else {
    setStatus(`索引 ${k} 已是 ${hex}`);
  }
}) as EventListener);

/* ------------------------------------------------ M2 绘制交互（指针） */
let painting = false;   // 铅笔/橡皮拖拽
let dragging = false;   // 矩形选区框选
let dragStart: [number, number] | null = null;
let lastCell: [number, number] | null = null;
let moveDrag: { downX: number; downY: number; z: number; dx: number; dy: number } | null = null;
let panDrag: { x: number; y: number; sl: number; st: number } | null = null;
let spaceTool: string | null = null; // 空格临时手掌前的工具
let shapeDrag: { kind: "line" | "rect" | "ellipse"; start: [number, number] } | null = null;
let lastShapeCells: Array<[number, number]> | null = null;
let lassoDrag = false;  // 磁力套索
let detailDrag = false; // M4 细节笔刷（只改标记，不改像素）
let lastDetailCell: [number, number] | null = null;

function cellFromEvent(e: PointerEvent): [number, number] | null {
  const doc = activeDoc();
  if (!doc) return null;
  const rect = canvas.getBoundingClientRect();
  const z = rect.width / doc.w;
  const x = Math.floor((e.clientX - rect.left) / z);
  const y = Math.floor((e.clientY - rect.top) / z);
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return null;
  return [x, y];
}

function toolValue(): number | "erase" {
  const { tool } = getState();
  if (tool === "eraser") return "erase";
  return getState().colorIndex;
}

canvas.addEventListener("pointerdown", (e) => {
  const doc = activeDoc();
  if (!doc || e.button !== 0) return;
  if (doc.lineart && getState().tool !== "hand") return; // 线稿只读；仅允许手掌平移
  const cell = cellFromEvent(e);
  if (!cell) return;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件（非活跃 pointerId） */ }
  const { tool } = getState();
  if (tool === "picker") {
    const i = cell[1] * doc.w + cell[0];
    const idx = compositeFill(doc, i);
    if (idx >= 0) setState({ colorIndex: idx });
    return;
  }
  if (tool === "move") {
    // 位移用按下点的屏幕像素算（画布自身被 transform 移动不影响）——消除"拽着不让走"的顿挫
    const rect = canvas.getBoundingClientRect();
    moveDrag = { downX: e.clientX, downY: e.clientY, z: rect.width / doc.w, dx: 0, dy: 0 };
    return;
  }
  if (tool === "hand") {
    panDrag = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    wrap.classList.add("panning");
    return;
  }
  if (tool === "lasso") {
    lassoDrag = true;
    setState({ selection: { kind: "poly", cells: new Set(), bounds: {
      x0: cell[0], y0: cell[1], x1: cell[0], y1: cell[1] }, path: [cell] } });
    return;
  }
  if (tool === "select") {
    dragStart = cell;
    setState({ selection: { kind: "rect", rect: {
      x0: cell[0], y0: cell[1], x1: cell[0], y1: cell[1] } } });
    dragging = true;
    return;
  }
  if (tool === "bucket") {
    bucketFill(doc, cell[0], cell[1], "fill", toolValue(), "油漆桶");
    return;
  }
  if (tool === "line" || tool === "rect" || tool === "ellipse") {
    shapeDrag = { kind: tool, start: cell };
    lastShapeCells = null;
    return;
  }
  if (tool === "detail") {
    if (doc.blank) { setStatus("空白画布没有源图，无法细节重算"); return; }
    detailDrag = true;
    lastDetailCell = cell;
    paintDetailMask(doc, [cell], e.altKey);
    return;
  }
  if (tool === "alpha") {
    if (e.shiftKey) {
      // 按色抠除：单击泛洪同色连通域（受选区限制）
      const n = magicAlphaErase(doc, cell[0], cell[1]);
      setStatus(n ? `按色抠除 ${n} 格` : "该处没有可抠除的同色区");
      return;
    }
    // 手动抠：拖拽刷透明（Alt = 恢复）
    painting = true;
    beginStroke(doc);
    drawStroke(cell, cell, e.altKey);
    lastCell = cell;
    return;
  }
  // 铅笔/橡皮：一笔一条历史
  painting = true;
  beginStroke(doc);
  drawStroke(cell, cell);
  lastCell = cell;
});

/** 细节笔刷：只增删标记格（橙色覆盖），不写像素；Alt = 擦除。 */
function paintDetailMask(doc: EditorDoc, pts: Array<[number, number]>, erase: boolean): void {
  const mask = doc.detailMask ?? (doc.detailMask = new Set<number>());
  let changed = false;
  for (const [px, py] of pts) {
    for (const [cx, cy] of brushTipCells(px, py, getState().brushSize)) {
      if (cx < 0 || cy < 0 || cx >= doc.w || cy >= doc.h || !scopeHas(doc, cx, cy)) continue;
      const i = cy * doc.w + cx;
      if (erase) {
        if (mask.delete(i)) changed = true;
      } else if (!mask.has(i)) {
        mask.add(i);
        changed = true;
      }
    }
  }
  if (changed) {
    redrawCanvas();
    syncDetailButtons();
  }
}

function drawStroke(from: [number, number], to: [number, number], erase = false): void {
  const doc = activeDoc();
  if (!doc) return;
  const cells = pixelPerfectLine(from[0], from[1], to[0], to[1])
    .flatMap(([x, y]) => brushTipCells(x, y, getState().brushSize));
  // 抠背景工具写 alpha 槽（0=透明；Alt 恢复）；铅笔/橡皮写 fill 槽
  const slot = getState().tool === "alpha" ? "alpha" : "fill";
  const value = slot === "alpha" ? (erase ? "erase" : 0) : toolValue();
  const changed = stampCells(doc, cells, slot, value);
  if (!changed.length) return;
  // 实时笔迹：只把变更格补丁进合成位图再重绘（不必整幅重建，提交时才全量刷新）
  patchBitmapCells(doc, changed);
  redrawCanvas();
}

canvas.addEventListener("pointermove", (e) => {
  const doc = activeDoc();
  if (!doc) return;
  if (painting) {
    const cell = cellFromEvent(e);
    if (cell && lastCell && (cell[0] !== lastCell[0] || cell[1] !== lastCell[1])) {
      drawStroke(lastCell, cell, e.altKey);
      lastCell = cell;
    }
  } else if (dragging && dragStart) {
    const cell = cellFromEvent(e);
    if (cell) setState({ selection: { kind: "rect", rect: {
      x0: Math.min(dragStart[0], cell[0]), y0: Math.min(dragStart[1], cell[1]),
      x1: Math.max(dragStart[0], cell[0]), y1: Math.max(dragStart[1], cell[1]) } } });
  } else if (moveDrag) {
    moveDrag.dx = Math.round((e.clientX - moveDrag.downX) / moveDrag.z);
    moveDrag.dy = Math.round((e.clientY - moveDrag.downY) / moveDrag.z);
    canvas.style.transform = `translate(${moveDrag.dx * moveDrag.z}px, ${moveDrag.dy * moveDrag.z}px)`;
  } else if (panDrag) {
    wrap.scrollLeft = panDrag.sl - (e.clientX - panDrag.x);
    wrap.scrollTop = panDrag.st - (e.clientY - panDrag.y);
  } else if (shapeDrag) {
    const cell = cellFromEvent(e);
    if (cell) {
      lastShapeCells = shapeCells(shapeDrag.kind, shapeDrag.start[0], shapeDrag.start[1], cell[0], cell[1], e.shiftKey);
      shapePreviewApply(doc, lastShapeCells, "fill", getState().colorIndex);
    }
  } else if (lassoDrag) {
    const raw = cellFromEvent(e);
    if (!raw) return;
    const sel = getState().selection;
    if (sel?.kind !== "poly") return;
    const [sx, sy] = magneticSnap(doc, raw[0], raw[1]);
    const last = sel.path[sel.path.length - 1];
    if (last && last[0] === sx && last[1] === sy) return;
    // 相邻吸附点之间插值，保证多边形连续（否则长跳会切角漏掉内部）
    const seg: Array<[number, number]> = last
      ? plainLineBetween(last, [sx, sy]).slice(1)
      : [[sx, sy]];
    if (!seg.length) return;
    const path: Array<[number, number]> = [...sel.path, ...seg];
    setState({ selection: {
      kind: "poly", cells: new Set(),
      bounds: {
        x0: Math.max(0, Math.min(...path.map((p) => p[0]))),
        y0: Math.max(0, Math.min(...path.map((p) => p[1]))),
        x1: Math.min(doc.w - 1, Math.max(...path.map((p) => p[0]))),
        y1: Math.min(doc.h - 1, Math.max(...path.map((p) => p[1]))),
      },
      path,
    } });
  } else if (detailDrag) {
    const cell = cellFromEvent(e);
    if (cell) {
      // 相邻采样点间插值，避免快速拖动留下断点
      const from = lastDetailCell ?? cell;
      paintDetailMask(doc, pixelPerfectLine(from[0], from[1], cell[0], cell[1]), e.altKey);
      lastDetailCell = cell;
    }
  }
});

const endPointer = (e: PointerEvent) => {
  const doc = activeDoc();
  if (painting && doc) {
    const t = getState().tool;
    endStroke(doc, t === "alpha" ? "抠背景" : t === "eraser" ? "橡皮" : "铅笔");
  }
  if (dragging && dragStart && doc) {
    const cell = cellFromEvent(e);
    // 单击未拖动 = 取消选区（PS 习惯）
    if (cell && cell[0] === dragStart[0] && cell[1] === dragStart[1]) {
      setState({ selection: null });
    }
  }
  if (moveDrag && doc) {
    canvas.style.transform = "";
    const ok = finishMove(doc, moveDrag.dx, moveDrag.dy);
    if (!ok) setStatus("当前层没有可移动的手改内容（或位移为 0）");
  }
  if (panDrag) {
    wrap.classList.remove("panning");
  }
  if (shapeDrag && doc) {
    shapePreviewEnd(doc);
    if (lastShapeCells && lastShapeCells.length) {
      paintCells(doc, lastShapeCells, "fill", toolValue(),
        `${shapeDrag.kind === "line" ? "直线" : shapeDrag.kind === "rect" ? "矩形" : "椭圆"}${e.shiftKey ? "(填充)" : ""}`);
    }
    lastShapeCells = null;
  }
  if (lassoDrag && doc) {
    const sel = getState().selection;
    if (sel?.kind === "poly") {
      if (sel.path.length >= 4) {
        const { cells, bounds } = polygonCells(doc, sel.path);
        if (cells.size) setState({ selection: { kind: "poly", cells, bounds, path: sel.path } });
        else setState({ selection: null });
      } else {
        setState({ selection: null }); // 单击未圈选 = 取消
      }
    }
  }
  painting = false; dragging = false; dragStart = null; lastCell = null;
  moveDrag = null; shapeDrag = null; lassoDrag = false; panDrag = null; detailDrag = false;
  lastDetailCell = null;
};
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", () => {
  const doc = activeDoc();
  if (shapeDrag && doc) shapePreviewEnd(doc); // 取消时不落历史
  painting = false; dragging = false; dragStart = null; lastCell = null;
  moveDrag = null; shapeDrag = null; lassoDrag = false; panDrag = null; detailDrag = false;
  lastDetailCell = null;
  canvas.style.transform = "";
  wrap.classList.remove("panning");
});

/* 空格 = 临时手掌（PS 习惯）。任何空格 keydown/keyup 一律 preventDefault，
 * 否则按住时的重复 keydown 会触发浏览器默认滚动（首次 preventDefault 拦不住 repeats） */
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
  e.preventDefault();
  if (e.repeat || spaceTool) return;
  const t = getState().tool;
  if (t === "hand") return;
  spaceTool = t;
  setState({ tool: "hand" });
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
  e.preventDefault();
  if (!spaceTool) return;
  setState({ tool: spaceTool as never });
  spaceTool = null;
});

/* 选区快捷操作：方向键移动 / Shift+方向键复制 / H·V 翻转 / Esc 取消 */
document.addEventListener("keydown", (e) => {
  const doc = activeDoc();
  if (!doc) return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
    return;
  }
  if (e.ctrlKey || e.metaKey) return;
  const { selection } = getState();
  const k = e.key.toLowerCase();
  const toolKeys: Record<string, string> = {
    b: "pencil", e: "eraser", g: "bucket", i: "picker", s: "select",
    v: "move", q: "lasso", l: "line", r: "rect", o: "ellipse", h: "hand", d: "detail",
    w: "alpha",
  };
  if (!selection && toolKeys[k]) { setState({ tool: toolKeys[k] as never }); return; }
  if (k === "m") { // 对称循环：关→H→V→四分
    const order = ["off", "h", "v", "quad"] as const;
    const cur = order.indexOf(getState().symmetry);
    setState({ symmetry: order[(cur + 1) % 4] });
    return;
  }
  if (e.key === "Escape") { setState({ selection: null }); return; }
  if (selection) {
    const dirs: Record<string, [number, number]> = {
      arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1],
    };
    const d = dirs[k];
    if (d) {
      e.preventDefault();
      moveSelectionBy(doc, d[0], d[1], e.shiftKey);
    } else if (k === "h") {
      if (!flipSelection(doc, "h")) setStatus("翻转仅支持矩形选区");
    } else if (k === "v") {
      if (!flipSelection(doc, "v")) setStatus("翻转仅支持矩形选区");
    }
  }
});

/* ------------------------------------------------ 导出对话框（批量/格式/倍率/预览） */

/** 文档像素合成（多图层栈+墨线）。transparent=true 时边缘泛洪去底色（轮廓外 alpha=0）。 */
function composeDocCanvas(doc: import("./store").EditorDoc, transparent = false): HTMLCanvasElement {
  return compositeDoc(doc, { transparent });
}

const expdlg = $("exportdlg") as HTMLDialogElement;
let expPreviewId: string | null = null;
let expZoom = 4;

/** 导出内容：像素画合成 / 索引 PNG（PLTE）/ 引擎线稿 / 像素墨线层。 */
type ExpContent = "composite" | "indexed" | "engine" | "ink";
function expContent(): ExpContent {
  const v = ($("exp-content") as HTMLSelectElement)?.value;
  return v === "indexed" || v === "engine" || v === "ink" ? v : "composite";
}

/** 引擎线稿缓存（key = doc.id:jobId）与在途请求，避免重复提取。 */
const lineartCache = new Map<string, HTMLImageElement>();
const lineartPending = new Map<string, Promise<HTMLImageElement | null>>();

function lineartKey(doc: import("./store").EditorDoc): string {
  return `${doc.id}:${doc.jobId}`;
}

/** 取该文档的引擎线稿（上传原图 / 按服务器路径提取；空白画布返回 null）。 */
function loadEngineLineart(doc: import("./store").EditorDoc): Promise<HTMLImageElement | null> {
  const key = lineartKey(doc);
  if (doc.lineart) {
    // 线稿文档已持有源分辨率图，直接返回当前资产（不读旧缓存，避免重提取后导出旧图）
    const img = ensureLineartImage(doc);
    if (!img) return Promise.resolve(null);
    if (img.complete && img.naturalWidth) return Promise.resolve(img);
    return new Promise((resolve) => {
      img.addEventListener("load", () => resolve(img.naturalWidth ? img : null), { once: true });
      img.addEventListener("error", () => resolve(null), { once: true });
    });
  }
  const hit = lineartCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = lineartPending.get(key);
  if (pending) return pending;
  const job = (async (): Promise<HTMLImageElement | null> => {
    try {
      let png: string | null = null;
      if (doc.src?.file) png = (await extractLineartFile(doc.src.file)).png;
      else if (doc.src?.path) png = (await extractLineartPath(doc.src.path)).png;
      if (!png) return null;
      const img = new Image();
      await new Promise<void>((res) => {
        img.onload = () => res();
        img.onerror = () => res();
        img.src = `data:image/png;base64,${png}`;
        if (img.complete && img.naturalWidth) res();
      });
      if (!img.naturalWidth) return null;
      lineartCache.set(key, img);
      return img;
    } catch (err) {
      setStatus(`线稿提取失败 ${doc.name}: ${(err as Error).message}`);
      return null;
    } finally {
      lineartPending.delete(key);
    }
  })();
  lineartPending.set(key, job);
  return job;
}

/** 按内容模式生成预览/导出源（合成/像素墨线）；引擎线稿走独立异步路径。 */
function expSource(doc: import("./store").EditorDoc): HTMLCanvasElement | null {
  if (doc.lineart) return null; // 线稿文档没有像素网格合成，导出走引擎线稿路径
  if (expContent() === "ink") return compositeLineart(doc);
  return composeDocCanvas(doc, expTransparent());
}

/** 导出文件名：模板为空=自动（名称_输出尺寸）；{name}/{size}/{preset} 由调用方给后缀。 */
function expNameWithSuffix(doc: import("./store").EditorDoc, autoSuffix: string): string {
  const name = doc.name.replace(/[\\/:*?"<>|]/g, "_");
  const tpl = ($("exp-name") as HTMLSelectElement).value;
  if (tpl === "auto") return `${name}${autoSuffix}`;
  return tpl
    .replace("{name}", name)
    .replace("{size}", String(doc.w))
    .replace("{preset}", doc.presetName);
}

/** 线稿模式固定 PNG；引擎线稿按源图原始分辨率，尺寸选项灰显；索引 PNG 不支持图集。 */
function expApplyContentUI(): void {
  const c = expContent();
  const fmt = $("exp-format") as HTMLSelectElement;
  const trans = $("exp-trans") as HTMLInputElement;
  const previewDoc = getState().docs.find((d) => d.id === expPreviewId);
  const lineartDoc = !!previewDoc?.lineart; // 线稿文档固定源分辨率 PNG
  const lockFormat = c === "engine" || c === "ink" || c === "indexed" || lineartDoc;
  fmt.disabled = lockFormat;
  trans.disabled = c === "engine" || c === "ink" || lineartDoc;
  if (lockFormat) fmt.value = "png";
  if (trans.disabled) trans.checked = false;
  $("exp-trans-row").classList.toggle("off", trans.disabled || fmt.value === "jpeg");
  const rawRes = c === "engine" || lineartDoc;
  ($("exp-scale") as HTMLSelectElement).disabled = rawRes;
  ($("exp-w") as HTMLInputElement).disabled = rawRes;
  ($("exp-h") as HTMLInputElement).disabled = rawRes;
  const noSheet = rawRes || c === "indexed"; // 索引 PNG 不合并图集
  const sheet = $("exp-sheet") as HTMLInputElement;
  sheet.disabled = noSheet;
  if (noSheet) sheet.checked = false;
  $("exp-sheet-row").classList.toggle("off", noSheet);
}

function expCheckedIds(): string[] {
  return [...expdlg.querySelectorAll<HTMLInputElement>("#exp-docs input:checked")].map((i) => i.dataset.id!);
}

function expUpdateDims(): void {
  const doc = getState().docs.find((d) => d.id === expPreviewId);
  if (!doc) return;
  if (doc.lineart) {
    ($("exp-w") as HTMLInputElement).value = String(doc.lineart.width);
    ($("exp-h") as HTMLInputElement).value = String(doc.lineart.height);
    return;
  }
  const scale = Number(($("exp-scale") as HTMLSelectElement).value) || 1;
  ($("exp-w") as HTMLInputElement).value = String(doc.w * scale);
  ($("exp-h") as HTMLInputElement).value = String(doc.h * scale);
}

function expRenderPreview(): void {
  const doc = getState().docs.find((d) => d.id === expPreviewId);
  const cv = $("exp-canvas") as HTMLCanvasElement;
  const pname = $("exp-pname") as HTMLElement;
  if (!doc) {
    cv.width = cv.height = 1;
    pname.textContent = "（无文档）";
    return;
  }
  const content = expContent();
  if (doc.lineart) {
    // 线稿文档：直接预览源分辨率图（无需再提取）
    const img = ensureLineartImage(doc);
    if (!img || !img.complete || !img.naturalWidth) {
      cv.width = cv.height = 1;
      cv.style.width = cv.style.height = "1px";
      pname.textContent = `${doc.name} · 线稿加载中…`;
      $("exp-zoomv").textContent = "—";
      img?.addEventListener("load", () => {
        if (expPreviewId === doc.id) {
          expFitZoom();
          expRenderPreview();
        }
      }, { once: true });
      return;
    }
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    cv.getContext("2d")!.drawImage(img, 0, 0);
    cv.style.imageRendering = "auto"; // 连续图像平滑缩放，不像素化
    cv.style.width = `${Math.max(1, Math.round(img.naturalWidth * expZoom))}px`;
    cv.style.height = `${Math.max(1, Math.round(img.naturalHeight * expZoom))}px`;
    pname.textContent = `${doc.name} · 线稿 ${img.naturalWidth}×${img.naturalHeight}`;
    $("exp-zoomv").textContent = `${Math.round(expZoom * 100)}%`;
    return;
  }
  if (content === "engine") {
    const img = lineartCache.get(lineartKey(doc));
    if (!img) {
      // 未就绪：清空并异步提取，完成后若仍是当前预览则重绘
      cv.width = cv.height = 1;
      cv.style.width = cv.style.height = "1px";
      pname.textContent = doc.src ? `${doc.name} · 线稿提取中…` : `${doc.name} · 无源图（空白画布）`;
      $("exp-zoomv").textContent = "—";
      if (doc.src) {
        void loadEngineLineart(doc).then(() => {
          if (expPreviewId === doc.id) {
            expFitZoom();
            expRenderPreview();
          }
        });
      }
      return;
    }
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    cv.getContext("2d")!.drawImage(img, 0, 0);
    cv.style.imageRendering = "auto"; // 连续图像平滑缩放，不像素化
    cv.style.width = `${Math.max(1, Math.round(img.naturalWidth * expZoom))}px`;
    cv.style.height = `${Math.max(1, Math.round(img.naturalHeight * expZoom))}px`;
    pname.textContent = `${doc.name} · 引擎线稿 ${img.naturalWidth}×${img.naturalHeight}`;
    $("exp-zoomv").textContent = `${Math.round(expZoom * 100)}%`;
    return;
  }
  const src = expSource(doc);
  if (!src) {
    // 像素墨线层为空：清空预览并提示
    cv.width = cv.height = 1;
    cv.style.width = cv.style.height = "1px";
    pname.textContent = `${doc.name} · 无墨线可预览`;
    $("exp-zoomv").textContent = "—";
    return;
  }
  cv.width = doc.w;
  cv.height = doc.h;
  cv.getContext("2d")!.drawImage(src, 0, 0);
  cv.style.imageRendering = ""; // 恢复 CSS 的像素化预览
  cv.style.width = `${Math.max(1, Math.round(doc.w * expZoom))}px`;
  cv.style.height = `${Math.max(1, Math.round(doc.h * expZoom))}px`;
  pname.textContent = doc.name
    + (content === "ink" ? " · 像素墨线层" : content === "indexed" ? " · 索引 PNG（PLTE）" : "");
  $("exp-zoomv").textContent = `${Math.round(expZoom * 100)}%`;
}

function openExport(): void {
  const { docs, activeIndex } = getState();
  const list = $("exp-docs");
  list.textContent = "";
  for (const d of docs) {
    const row = document.createElement("label");
    row.className = "pf-exp-row" + (d.id === expPreviewId ? " cur" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.id = d.id;
    const name = document.createElement("span");
    name.textContent = d.name;
    const dims = document.createElement("span");
    dims.className = "pf-val";
    dims.textContent = d.lineart ? `${d.w}×${d.h} 线稿` : `${d.w}×${d.h}`;
    row.append(cb, name, dims);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      expPreviewId = d.id;
      if (d.lineart) ($("exp-content") as HTMLSelectElement).value = "engine";
      expApplyContentUI();
      expFitZoom();
      expRenderPreview();
      expUpdateDims();
      list.querySelectorAll(".pf-exp-row").forEach((r) => r.classList.remove("cur"));
      row.classList.add("cur");
    });
    list.appendChild(row);
  }
  expPreviewId = docs[activeIndex]?.id ?? docs[0]?.id ?? null;
  const previewDoc = docs.find((d) => d.id === expPreviewId);
  // 打开时按当前文档类型对齐内容选项：线稿文档默认清晰线稿，像素文档回到合成
  ($("exp-content") as HTMLSelectElement).value = previewDoc?.lineart ? "engine" : "composite";
  expdlg.showModal();
  expApplyContentUI();
  // 弹窗布局完成后（flex 尺寸就绪）再做预览适配
  requestAnimationFrame(() => {
    expFitZoom();
    expRenderPreview();
  });
  expRenderPreview();
  expUpdateDims();
}

/** 预览缩放适配预览框（引擎线稿按其原始分辨率算）。 */
function expFitZoom(): void {
  const doc = getState().docs.find((d) => d.id === expPreviewId);
  if (!doc) { expZoom = 1; return; }
  let w = doc.w, h = doc.h;
  if (doc.lineart) {
    w = doc.lineart.width;
    h = doc.lineart.height;
  } else if (expContent() === "engine") {
    const img = lineartCache.get(lineartKey(doc));
    if (img) { w = img.naturalWidth; h = img.naturalHeight; }
  }
  const stage = document.querySelector(".pf-export-stage") as HTMLElement;
  const zw = (stage.clientWidth - 40) / w;
  const zh = (stage.clientHeight - 40) / h;
  expZoom = Math.max(0.05, Math.min(16, zw, zh));
}

$("export").addEventListener("click", openExport);
$("exp-cancel").addEventListener("click", () => expdlg.close());
document.getElementById("exp-all")?.addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  expdlg.querySelectorAll<HTMLInputElement>("#exp-docs input").forEach((i) => { i.checked = on; });
});
$("exp-zoomin").addEventListener("click", () => { expZoom = Math.min(16, expZoom * 1.25); expRenderPreview(); });
$("exp-zoomout").addEventListener("click", () => { expZoom = Math.max(0.05, expZoom / 1.25); expRenderPreview(); });
$("exp-scale").addEventListener("change", expUpdateDims);
$("exp-content").addEventListener("change", () => {
  expApplyContentUI();
  expFitZoom();
  expRenderPreview();
});
/* JPEG 无透明：禁用复选框并强制取消勾选 */
$("exp-format").addEventListener("change", () => {
  const jpeg = ($("exp-format") as HTMLSelectElement).value === "jpeg";
  const row = $("exp-trans-row");
  row.classList.toggle("off", jpeg);
  if (jpeg) ($("exp-trans") as HTMLInputElement).checked = false;
});
function expTransparent(): boolean {
  return ($("exp-trans") as HTMLInputElement).checked
    && ($("exp-format") as HTMLSelectElement).value !== "jpeg";
}
$("exp-trans").addEventListener("change", () => expRenderPreview());
($("exp-w") as HTMLInputElement).addEventListener("change", () => {
  const doc = getState().docs.find((d) => d.id === expPreviewId);
  if (!doc || doc.lineart) return;
  const w = Math.max(1, Math.round(Number(($("exp-w") as HTMLInputElement).value) || doc.w));
  const scale = Math.max(0.01, Math.min(16, w / doc.w));
  ($("exp-scale") as HTMLSelectElement).value = String([1, 2, 4, 8, 16].includes(Math.round(scale)) ? Math.round(scale) : scale.toFixed(2));
  ($("exp-w") as HTMLInputElement).value = String(Math.round(doc.w * scale));
  ($("exp-h") as HTMLInputElement).value = String(Math.round(doc.h * scale));
});
($("exp-h") as HTMLInputElement).addEventListener("change", () => {
  const doc = getState().docs.find((d) => d.id === expPreviewId);
  if (!doc || doc.lineart) return;
  const h = Math.max(1, Math.round(Number(($("exp-h") as HTMLInputElement).value) || doc.h));
  const scale = Math.max(0.01, Math.min(16, h / doc.h));
  ($("exp-w") as HTMLInputElement).value = String(Math.round(doc.w * scale));
  ($("exp-h") as HTMLInputElement).value = String(Math.round(doc.h * scale));
});
$("exp-ok").addEventListener("click", async () => {
  const ids = expCheckedIds();
  if (!ids.length) { setStatus("尚未勾选任何文档"); return; }
  const content = expContent();

  // 索引 PNG：把最终索引网格交给引擎写 PLTE(+tRNS)（保留调色板结构，游戏引擎友好）
  if (content === "indexed") {
    const scale = Number(($("exp-scale") as HTMLSelectElement).value) || 1;
    const withAlpha = expTransparent(); // 勾选=透明格写 tRNS；不勾=忽略透明（全部有色）
    let n = 0, skipped = 0;
    const failed: string[] = [];
    for (const id of ids) {
      const doc = getState().docs.find((d) => d.id === id);
      if (!doc || doc.lineart) { skipped++; continue; }
      try {
        const grid = composeIndexGrid(doc, withAlpha);
        const outW = Math.round(doc.w * scale), outH = Math.round(doc.h * scale);
        const rows: number[][] = [];
        for (let y = 0; y < doc.h; y++) rows.push(Array.from(grid.subarray(y * doc.w, (y + 1) * doc.w)));
        const r = await exportIndexed(doc.palette, rows, outW, outH);
        const a = document.createElement("a");
        a.download = `${expNameWithSuffix(doc, `_${outW}px_indexed`)}.png`;
        a.href = `data:image/png;base64,${r.png}`;
        a.click();
        n++;
        setStatus(`索引 PNG：${r.width}×${r.height} · ${r.colors} 色${r.transparent ? " · 含透明" : ""}`);
        if (ids.length > 1) await new Promise((res) => setTimeout(res, 250));
      } catch (err) {
        failed.push(`${doc.name}（${(err as Error).message}）`);
      }
    }
    expdlg.close();
    if (failed.length) {
      setStatus(`索引 PNG 失败：${failed.slice(0, 2).join("；")}${failed.length > 2 ? "…" : ""}`);
      return;
    }
    setStatus(`已导出 ${n} 个索引 PNG${skipped ? ` · 跳过 ${skipped} 个线稿文档` : ""}`);
    return;
  }

  // 引擎线稿：按源图原始分辨率导出（不做缩放）
  if (content === "engine") {
    let n = 0;
    let skipped = 0;
    for (const id of ids) {
      const doc = getState().docs.find((d) => d.id === id);
      if (!doc?.src && !doc?.lineart) { skipped++; continue; }
      const img = await loadEngineLineart(doc);
      if (!img) { skipped++; continue; }
      const a = document.createElement("a");
      a.download = `${expNameWithSuffix(doc, "_lineart")}.png`;
      a.href = img.src;
      a.click();
      n++;
      if (ids.length > 1) await new Promise((r) => setTimeout(r, 250));
    }
    expdlg.close();
    if (!n && skipped) { setStatus(`未导出任何线稿 · 跳过 ${skipped} 个无源图文档`); return; }
    setStatus(`已导出 ${n} 个引擎线稿（原始分辨率）${skipped ? ` · 跳过 ${skipped} 个无源图文档` : ""}`);
    return;
  }

  const lineart = content === "ink";
  const scale = Number(($("exp-scale") as HTMLSelectElement).value) || 1;
  const format = lineart ? "png" : ($("exp-format") as HTMLSelectElement).value;
  const transparent = !lineart && expTransparent();
  const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const ext = format === "jpeg" ? "jpg" : format;

  // 精灵图集：按尺寸分组，每组同尺寸文档水平拼成一条（一个文件）
  if (($("exp-sheet") as HTMLInputElement).checked) {
    const picked = ids
      .map((id) => getState().docs.find((d) => d.id === id))
      .filter((d): d is import("./store").EditorDoc => !!d);
    const groups = new Map<string, import("./store").EditorDoc[]>();
    for (const d of picked) {
      const key = `${d.w}x${d.h}`;
      const list = groups.get(key);
      if (list) list.push(d); else groups.set(key, [d]);
    }
    let files = 0, merged = 0, skipped = 0;
    for (const group of groups.values()) {
      const w = group[0].w, h = group[0].h;
      const cellW = Math.round(w * scale), cellH = Math.round(h * scale);
      const sources = group
        .map((doc) => ({ doc, src: expSource(doc) }))
        .filter((x): x is { doc: import("./store").EditorDoc; src: HTMLCanvasElement } => !!x.src);
      if (!sources.length) { skipped += group.length; continue; }
      const out = document.createElement("canvas");
      out.width = cellW * sources.length;
      out.height = cellH;
      const ctx = out.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      if (format === "jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height); }
      sources.forEach(({ src }, k) => ctx.drawImage(src, k * cellW, 0, cellW, cellH));
      const a = document.createElement("a");
      a.download = `spritesheet_${w}x${h}_${sources.length}${lineart ? "_ink" : ""}.${ext}`;
      a.href = out.toDataURL(mime);
      a.click();
      files++;
      merged += sources.length;
      await new Promise((r) => setTimeout(r, 250));
    }
    expdlg.close();
    const skipMsg = skipped ? ` · 跳过 ${skipped} 个无${lineart ? "墨线" : "源"}文档` : "";
    if (!files) { setStatus(`未导出任何图集${skipMsg}`); return; }
    setStatus(`已导出 ${files} 张图集（合并 ${merged} 个文档，按尺寸分组）${skipMsg}`);
    return;
  }

  let n = 0;
  let skipped = 0;
  let lineartSkipped = 0;
  for (const id of ids) {
    const doc = getState().docs.find((d) => d.id === id);
    if (!doc) continue;
    if (doc.lineart) { lineartSkipped++; continue; } // 线稿文档请选「线稿（引擎提取）」内容
    const src = expSource(doc);
    if (!src) { skipped++; continue; } // 像素墨线层为空
    const out = document.createElement("canvas");
    out.width = Math.round(doc.w * scale);
    out.height = Math.round(doc.h * scale);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    if (format === "jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height); }
    ctx.drawImage(src, 0, 0, out.width, out.height);
    const a = document.createElement("a");
    a.download = `${expNameWithSuffix(doc, `_${out.width}px${lineart ? "_ink" : ""}`)}.${ext}`;
    a.href = out.toDataURL(mime);
    a.click();
    n++;
    if (ids.length > 1) await new Promise((r) => setTimeout(r, 250)); // 多文件下载间隔
  }
  expdlg.close();
  const skipParts: string[] = [];
  if (skipped) skipParts.push(`${skipped} 个无${lineart ? "墨线" : "源"}文档`);
  if (lineartSkipped) skipParts.push(`${lineartSkipped} 个线稿文档需选「线稿（引擎提取）」内容`);
  const skipMsg = skipParts.length ? ` · 跳过 ${skipParts.join("；")}` : "";
  if (!n && skipParts.length) { setStatus(`未导出任何文件${skipMsg}`); return; }
  setStatus(lineart
    ? `已导出 ${n} 个像素墨线层（PNG ${Math.round(scale * 100)}%）${skipMsg}`
    : `已导出 ${n} 个文件（${format.toUpperCase()} ${Math.round(scale * 100)}%${transparent ? " · 透明" : ""}）${skipMsg}`);
});

/* 进度弹窗不可手动关闭 */
($("progd") as HTMLDialogElement).addEventListener("cancel", (e) => e.preventDefault());

subscribe(redrawCanvas);

/* ---------------------------------------------------------------- 控件 */
$("open").addEventListener("click", () => $("file-input").click());
$("open-folder").addEventListener("click", () => $("folder-input").click());
$("preset").addEventListener("change", (e) => {
  const preset = (e.target as HTMLSelectElement).value;
  setState({ preset });
  const doc = activeDoc();
  if (doc && !doc.blank) updateDoc(doc, { presetName: preset, recipe: presetRecipe(preset) });
  void applyRecipeChange(preset);
});
$("size").addEventListener("change", (e) => {
  setState({ size: Number((e.target as HTMLSelectElement).value) });
  void applyRecipeChange();
});

/* ------------------------------------------------ 参数面板（M3，每文档配方） */
const rpRanges: Array<[string, keyof RecipeParams, (v: number) => string]> = [
  ["rp-edge", "edge", (v) => v.toFixed(1)],
  ["rp-dark", "dark", (v) => v.toFixed(1)],
  ["rp-contrast", "contrast", (v) => v.toFixed(2)],
  ["rp-bright", "brightContrast", (v) => v.toFixed(2)],
  ["rp-soft", "softRatio", (v) => v.toFixed(2)],
  ["rp-merge", "mergeDelta", (v) => v.toFixed(2)],
  ["rp-maxcolors", "maxColors", (v) => String(Math.round(v))],
];
let recipeTimer = 0;
let lastSyncedDocId: string | null = null;

function patchRecipe(patch: Partial<RecipeParams>): void {
  const doc = activeDoc();
  if (!doc || doc.blank) return;
  updateDoc(doc, { recipe: { ...doc.recipe, ...patch } });
}

/** 滑杆改动 300ms 防抖后统一重转换（避免拖动过程打爆引擎）。 */
function scheduleRecipeApply(): void {
  window.clearTimeout(recipeTimer);
  recipeTimer = window.setTimeout(() => void applyRecipeChange(), 300);
}

/** 参数面板回显：活动文档切换时同步配方、预设与尺寸下拉。 */
function syncRecipeUI(): void {
  const doc = activeDoc();
  const useDoc = doc && !doc.blank ? doc : null; // 空白画布用全局预设（不随文档配方）
  const r = useDoc?.recipe ?? presetRecipe(getState().preset);
  // 切换标签：把全局预设/尺寸对齐该文档，避免下一次操作误用旧值
  if (useDoc && useDoc.id !== lastSyncedDocId) {
    lastSyncedDocId = useDoc.id;
    if (getState().preset !== useDoc.presetName) setState({ preset: useDoc.presetName });
    const sizeSel = $("size") as HTMLSelectElement;
    const docLong = Math.max(useDoc.w, useDoc.h); // 尺寸=长边（非正方形素材）
    if (docLong !== getState().size && [...sizeSel.options].some((o) => Number(o.value) === docLong)) {
      setState({ size: docLong });
    }
  }
  ($("preset") as HTMLSelectElement).value = useDoc?.presetName ?? getState().preset;

  for (const [id, key, fmt] of rpRanges) {
    const el = $(id) as HTMLInputElement;
    const v = Number(r[key]);
    el.value = String(v);
    $(`${id}-v`).textContent = fmt(v);
  }
  ($("rp-pal") as HTMLSelectElement).value =
    r.paletteSource === "extract" ? "extract" : `builtin:${r.paletteRef}`;
  ($("rp-lineart") as HTMLSelectElement).value = r.lineart;
  ($("rp-ink") as HTMLInputElement).checked = r.ink;
  ($("rp-lock") as HTMLInputElement).checked = r.paletteLock;
  ($("rp-all") as HTMLInputElement).checked = getState().applyAll;
  $("rp-scope").textContent = getState().applyAll ? "全部标签" : "仅当前文档";

  const off = !doc || !!doc.blank || !!doc.lineart;
  for (const [id] of rpRanges) ($(id) as HTMLInputElement).disabled = off;
  ($("rp-pal") as HTMLSelectElement).disabled = off;
  ($("rp-lineart") as HTMLSelectElement).disabled = off;
  ($("rp-ink") as HTMLInputElement).disabled = off;
  ($("rp-maxcolors") as HTMLInputElement).disabled = off || r.paletteSource !== "extract";
  ($("rp-lock") as HTMLInputElement).disabled = off || r.paletteSource !== "extract";
}

/** 线稿文档/线稿预设的界面模式：隐藏像素尺寸、参数、编辑工具与像素面板。 */
let lastModeDocId: string | null = null; // 折叠状态只在「切换文档」时重置，避免每次 setState 覆盖用户手动展开
function syncDocModeUI(): void {
  const doc = activeDoc();
  const lineartDoc = !!doc?.lineart;
  const lineartPreset = getState().preset === "lineart";
  $("size-field").hidden = lineartPreset || lineartDoc;
  $("params").hidden = lineartPreset || lineartDoc;
  $("tools-card").hidden = lineartDoc;
  $("pixel-panels").hidden = lineartDoc;
  $("lineart-panels").hidden = !lineartDoc;
  $("grid").hidden = lineartDoc;
  $("underlay-wrap").hidden = lineartDoc;
  $("detail-card").hidden = lineartDoc;
  // 空白画布不参与转换：默认折叠「转换工具」与「细节增强」（用户仍可手动展开/折叠）
  const docId = doc?.id ?? null;
  if (docId !== lastModeDocId) {
    lastModeDocId = docId;
    const blank = !!doc?.blank;
    ($("convert-card") as HTMLDetailsElement).open = !blank;
    ($("detail-card") as HTMLDetailsElement).open = !blank;
  }
  ($("detail-level") as HTMLSelectElement).value = String(getState().detailLevel);
  syncDetailButtons();
  const modeNote = $("mode-note");
  if (lineartPreset || lineartDoc) {
    modeNote.textContent = "线稿模式：按源图分辨率清晰提取，不使用像素网格与尺寸。";
    modeNote.hidden = false;
  } else {
    modeNote.textContent = "";
    modeNote.hidden = true;
  }
  if (doc?.lineart) {
    $("la-dims").textContent = `${doc.w}×${doc.h} px · ${doc.lineart.mode.toUpperCase()}`;
  }
  if (lineartDoc && getState().selection) setState({ selection: null });
}

/** 细节增强按钮/文案同步（标记笔刷改动不经过 state，需直接调用）。 */
function syncDetailButtons(): void {
  const doc = activeDoc();
  const can = !!doc && !doc.lineart && !doc.blank;
  const n = can ? doc!.detailMask?.size ?? 0 : 0;
  ($("detail-apply") as HTMLButtonElement).disabled = !can || n === 0;
  ($("detail-clear") as HTMLButtonElement).disabled = !can || n === 0;
  const note = $("detail-note");
  if (!can) {
    note.textContent = "空白画布没有源图，无法细节重算。";
    note.hidden = false;
  } else if (n) {
    note.textContent = `已标记 ${n} 格`;
    note.hidden = false;
  } else {
    note.textContent = "";
    note.hidden = true;
  }
}

for (const [id, key, fmt] of rpRanges) {
  const el = $(id) as HTMLInputElement;
  el.addEventListener("input", () => {
    const v = Number(el.value);
    $(`${id}-v`).textContent = fmt(v);
    patchRecipe({ [key]: v } as Partial<RecipeParams>);
    scheduleRecipeApply();
  });
}
$("rp-pal").addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v === "extract") patchRecipe({ paletteSource: "extract" });
  else patchRecipe({ paletteSource: "builtin", paletteRef: v.split(":")[1] ?? "gameboy" });
  void applyRecipeChange();
});
$("rp-lineart").addEventListener("change", (e) => {
  patchRecipe({ lineart: (e.target as HTMLSelectElement).value as RecipeParams["lineart"] });
  void applyRecipeChange();
});
$("rp-ink").addEventListener("change", (e) => {
  patchRecipe({ ink: (e.target as HTMLInputElement).checked });
  void applyRecipeChange();
});
/* M5-4 锁定色板：开启时以当前色板为锁定色，重转换强制保留（≤32 色） */
$("rp-lock").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  const doc = activeDoc();
  const seedColors = on && doc
    ? doc.paletteBase.slice(0, 32).map((c) => [...c] as [number, number, number])
    : [];
  patchRecipe({ paletteLock: on, seedColors });
  void applyRecipeChange();
});
$("rp-all").addEventListener("change", (e) => {
  const v = (e.target as HTMLInputElement).checked;
  setState({ applyAll: v });
  setStatus(v ? "参数改动将应用到全部标签" : "参数改动仅作用于当前文档");
});

/* ------------------------------------------------ 配方 JSON 导出/导入（M5-5） */
interface RecipeFileV1 {
  type: "pixelforge.recipe";
  version: 1;
  preset: string;
  recipe: RecipeParams;
  size?: number;
}

/** 只接受已知字段，避免坏文件把文档配方污染成非法状态。 */
function sanitizeRecipe(raw: unknown): RecipeParams | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const base = presetRecipe("photo");
  const num = (k: keyof RecipeParams, lo: number, hi: number) => {
    const v = o[k as string];
    return typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : (base[k] as number);
  };
  const seeds = Array.isArray(o.seedColors)
    ? (o.seedColors as unknown[])
        .filter((c): c is number[] => Array.isArray(c) && c.length === 3)
        .slice(0, 32)
        .map((c) => [clampByte(c[0]), clampByte(c[1]), clampByte(c[2])] as [number, number, number])
    : [];
  const palSrc = o.paletteSource === "builtin" ? "builtin" : "extract";
  const lineart = o.lineart === "xdog" || o.lineart === "onnx" ? o.lineart : "off";
  return {
    edge: num("edge", 0, 4),
    dark: num("dark", 0, 4),
    contrast: num("contrast", 0, 2),
    brightContrast: num("brightContrast", 0, 0.95),
    softRatio: num("softRatio", 1, 2.5),
    mergeDelta: num("mergeDelta", 0, 0.2),
    paletteSource: palSrc,
    paletteRef: typeof o.paletteRef === "string" ? o.paletteRef : base.paletteRef,
    maxColors: Math.round(num("maxColors", 2, 128)),
    paletteLock: o.paletteLock === true,
    seedColors: seeds,
    ink: o.ink === true,
    lineart,
  };
}

$("rp-export").addEventListener("click", () => {
  const doc = activeDoc();
  if (!doc) { setStatus("没有打开的文档"); return; }
  const payload: RecipeFileV1 = {
    type: "pixelforge.recipe", version: 1,
    preset: doc.presetName,
    recipe: { ...doc.recipe, seedColors: doc.recipe.seedColors.map((c) => [...c] as [number, number, number]) },
    size: doc.w,
  };
  const safe = doc.name.replace(/[\\/:*?"<>|]/g, "_");
  downloadText(`${safe}.recipe.json`, JSON.stringify(payload, null, 2) + "\n");
  setStatus(`已导出配方 → ${safe}.recipe.json`);
});
$("rp-import").addEventListener("click", () => ($("rp-input") as HTMLInputElement).click());
$("rp-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const doc = activeDoc();
  if (!file || !doc) return;
  if (doc.blank) { setStatus("空白画布不参与转换，无法套用配方"); return; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setStatus("配方文件不是合法 JSON");
    return;
  }
  const obj = (parsed ?? {}) as Partial<RecipeFileV1> & { recipe?: unknown };
  const recipe = sanitizeRecipe(obj.recipe ?? parsed);
  if (!recipe) { setStatus("配方文件缺少 recipe 字段"); return; }
  const preset = typeof obj.preset === "string" && ["photo", "illustration", "lineart"].includes(obj.preset)
    ? obj.preset : doc.presetName;
  updateDoc(doc, { recipe, presetName: preset });
  if (typeof obj.size === "number" && [16, 24, 32, 48, 64, 96, 128, 192, 256, 512].includes(obj.size)) {
    ($("size") as HTMLSelectElement).value = String(obj.size);
    setState({ size: obj.size });
  }
  setState({ preset });
  syncRecipeUI();
  setStatus(`已导入配方（${preset}），正在重转换…`);
  await applyRecipeChange(preset);
  setStatus(`配方已导入并重转换 ${doc.name}`);
});
$("detail-level").addEventListener("change", (e) => {
  setState({ detailLevel: Number((e.target as HTMLSelectElement).value) });
});
$("detail-apply").addEventListener("click", () => void rerunDetailRegion());
$("detail-clear").addEventListener("click", () => {
  const doc = activeDoc();
  if (!doc?.detailMask?.size) return;
  doc.detailMask = new Set();
  redrawCanvas();
  syncDetailButtons();
  setStatus("细节标记已清除");
});
subscribe(syncRecipeUI);
subscribe(syncDocModeUI);
syncRecipeUI();
syncDocModeUI();

/* ------------------------------------------------ 色板变换（M3，改板不改画） */
function syncPaletteFxUI(): void {
  const doc = activeDoc();
  const fx = doc?.paletteFx ?? ZERO_PALETTE_FX;
  const light = Math.round(fx.lightness * 100);
  const hue = Math.round(fx.hue);
  const sat = Math.round(fx.saturation * 100);
  ($("pfx-light") as HTMLInputElement).value = String(light);
  ($("pfx-hue") as HTMLInputElement).value = String(hue);
  ($("pfx-sat") as HTMLInputElement).value = String(sat);
  $("pfx-light-v").textContent = String(light);
  $("pfx-hue-v").textContent = `${hue}°`;
  $("pfx-sat-v").textContent = String(sat);
  $("pfx-v").textContent = light || hue || sat ? "已变换" : "原色";
  const off = !doc;
  for (const id of ["pfx-light", "pfx-hue", "pfx-sat", "pfx-reset"]) {
    ($(id) as HTMLInputElement).disabled = off;
  }
}

/** 整板重生成：只改 doc.palette，格子/手改索引一律不动。 */
function applyPaletteFx(patch: Partial<PaletteFx>): void {
  const doc = activeDoc();
  if (!doc) return;
  const fx: PaletteFx = { ...(doc.paletteFx ?? ZERO_PALETTE_FX), ...patch };
  invalidateBitmaps(doc);
  updateDoc(doc, { paletteFx: fx, palette: transformPalette(doc.paletteBase, fx) });
}
$("pfx-light").addEventListener("input", (e) => {
  applyPaletteFx({ lightness: Number((e.target as HTMLInputElement).value) / 100 });
});
$("pfx-hue").addEventListener("input", (e) => {
  applyPaletteFx({ hue: Number((e.target as HTMLInputElement).value) });
});
$("pfx-sat").addEventListener("input", (e) => {
  applyPaletteFx({ saturation: Number((e.target as HTMLInputElement).value) / 100 });
});
$("pfx-reset").addEventListener("click", () => applyPaletteFx({ ...ZERO_PALETTE_FX }));
subscribe(syncPaletteFxUI);
syncPaletteFxUI();

/* ------------------------------------------------ 色板导入导出（M5-3，.hex / .gpl） */
const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** 解析 .hex（每行 RRGGBB / #RRGGBB）与 .gpl（GIMP：R G B [name]）色板文本。 */
function parsePaletteText(text: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^GIMP Palette/i.test(line) || /^(Name|Columns)\s*:/i.test(line)) continue;
    const hex = line.replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      out.push([
        parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16),
      ]);
    } else {
      const m = line.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s|$)/);
      if (m) out.push([clampByte(+m[1]), clampByte(+m[2]), clampByte(+m[3])]);
    }
    if (out.length >= 256) break; // PNG 索引上限
  }
  return out;
}

const hexPair = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();

function paletteToHex(colors: [number, number, number][]): string {
  return colors.map((c) => c.map(hexPair).join("")).join("\n") + "\n";
}

function paletteToGpl(colors: [number, number, number][], name: string): string {
  const lines = ["GIMP Palette", `Name: ${name}`, "Columns: 16", "#"];
  for (const c of colors) {
    const rgb = c.map((v) => String(v).padStart(3)).join(" ");
    lines.push(`${rgb}\t#${c.map(hexPair).join("")}`);
  }
  return lines.join("\n") + "\n";
}

function downloadText(filename: string, text: string): void {
  const a = document.createElement("a");
  a.download = filename;
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.click();
  URL.revokeObjectURL(a.href);
}

$("pal-import").addEventListener("click", () => ($("pal-input") as HTMLInputElement).click());
$("pal-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const doc = activeDoc();
  if (!file || !doc) return;
  const colors = parsePaletteText(await file.text());
  if (!colors.length) { setStatus("色板文件无法解析（支持 .hex / .gpl）"); return; }
  const changed = setPaletteBaseWithRemap(doc, colors, `导入色板 ${colors.length} 色`);
  invalidateBitmaps(doc);
  redrawCanvas();
  setStatus(`已导入色板 ${colors.length} 色 · 按最近色重映射 ${changed} 格（Ctrl+Z 可撤销）`);
});
$("pal-export-hex").addEventListener("click", () => {
  const doc = activeDoc();
  if (!doc) return;
  downloadText(`${doc.name}.hex`, paletteToHex(doc.paletteBase));
  setStatus(`已导出 ${doc.paletteBase.length} 色 → ${doc.name}.hex`);
});
$("pal-export-gpl").addEventListener("click", () => {
  const doc = activeDoc();
  if (!doc) return;
  downloadText(`${doc.name}.gpl`, paletteToGpl(doc.paletteBase, doc.name));
  setStatus(`已导出 ${doc.paletteBase.length} 色 → ${doc.name}.gpl`);
});

function lineartZoom(v: number): number {
  return Math.max(0.05, Math.min(8, v));
}
$("zoom-in").addEventListener("click", () => {
  const z = getState().zoom;
  setState({ zoom: activeDoc()?.lineart ? lineartZoom(z * 1.25) : Math.min(24, z + 1) });
});
$("zoom-out").addEventListener("click", () => {
  const z = getState().zoom;
  setState({ zoom: activeDoc()?.lineart ? lineartZoom(z / 1.25) : Math.max(1, z - 1) });
});
$("grid").addEventListener("click", () => {
  const v = !getState().showGrid;
  setState({ showGrid: v });
  $("grid").setAttribute("aria-pressed", String(v));
});
$("underlay").addEventListener("input", (e) => {
  setState({ underlay: Number((e.target as HTMLInputElement).value) });
});

const compareBtn = $("compare");
const setCompare = (v: boolean) => {
  setState({ compare: v });
  compareBtn.setAttribute("aria-pressed", String(v));
};
compareBtn.addEventListener("pointerdown", () => setCompare(true));
compareBtn.addEventListener("pointerup", () => setCompare(false));
compareBtn.addEventListener("pointerleave", () => setCompare(false));

/* ---------------------------------------------------------------- 新建画布 */
// PICO-8 经典 16 色（顺序即索引；7 = 近白，作空白底色）
const DEFAULT_PALETTE: [number, number, number][] = [
  [0x00, 0x00, 0x00], [0x1d, 0x2b, 0x53], [0x7e, 0x25, 0x53], [0x00, 0x87, 0x51],
  [0xab, 0x52, 0x36], [0x5f, 0x57, 0x4f], [0xc2, 0xc3, 0xc7], [0xff, 0xf1, 0xe8],
  [0xff, 0x00, 0x4d], [0xff, 0xa3, 0x00], [0xff, 0xec, 0x27], [0x00, 0xe4, 0x36],
  [0x29, 0xad, 0xff], [0x83, 0x76, 0x9c], [0xff, 0x77, 0xa8], [0xff, 0xcc, 0xaa],
];
const WHITE_IDX = 7;
let blankSeq = 0;

const newDlg = $("newdlg") as HTMLDialogElement;
$("new").addEventListener("click", () => {
  newDlg.showModal();
});
$("new-cancel").addEventListener("click", () => newDlg.close(""));
function createBlank(): void {
  const clamp = (v: number) => Math.max(8, Math.min(256, Math.round(v) || 32));
  const w = clamp(Number(($("new-w") as HTMLInputElement).value));
  const h = clamp(Number(($("new-h") as HTMLInputElement).value));
  newDlg.close("");
  const canvasLayer = mkLayer("画布层", "canvas"); // 空白画布只有画布层（白底）
  addDoc({
    name: `未命名-${++blankSeq}`,
    jobId: "",
    w,
    h,
    palette: DEFAULT_PALETTE,
    paletteBase: DEFAULT_PALETTE,
    paletteFx: { ...ZERO_PALETTE_FX },
    recipe: presetRecipe("photo"),
    presetName: "photo",
    fill: new Int32Array(w * h).fill(WHITE_IDX),
    ink: null,
    alpha: null,
    inkVisible: true,
    inkOpacity: 1,
    layers: [canvasLayer],
    activeLayerId: canvasLayer.id,
    baseLayerId: canvasLayer.id,
    sourceUrl: "",
    colorsUsed: 1,
    ms: 0,
    blank: true,
  });
  setState({ zoom: fitZoomFor(w, h), colorIndex: 0 }); // 0 = 黑，画在白底上顺手
}
$("new-ok").addEventListener("click", createBlank);
$("empty-open").addEventListener("click", () => $("file-input").click());
$("empty-new").addEventListener("click", () => newDlg.showModal());
$("empty-sample").addEventListener("click", () => openSampleProject());
for (const id of ["new-w", "new-h"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") createBlank();
  });
}

/* 滚轮缩放 + 光标坐标 */
wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  const z = getState().zoom;
  if (activeDoc()?.lineart) {
    setState({ zoom: lineartZoom(e.deltaY < 0 ? z * 1.2 : z / 1.2) });
    return;
  }
  const dir = e.deltaY < 0 ? 1 : -1;
  setState({ zoom: Math.min(24, Math.max(1, z + dir)) });
}, { passive: false });

canvas.addEventListener("mousemove", (e) => {
  const doc = activeDoc();
  if (!doc) return;
  const rect = canvas.getBoundingClientRect();
  const z = rect.width / doc.w;
  const x = Math.floor((e.clientX - rect.left) / z);
  const y = Math.floor((e.clientY - rect.top) / z);
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) {
    $("stat-cursor").textContent = "—";
    return;
  }
  if (doc.lineart) {
    $("stat-cursor").textContent = `x:${x} y:${y} px`;
    return;
  }
  const idx = compositeFill(doc, y * doc.w + x);
  $("stat-cursor").textContent = `x:${x} y:${y} ${hexOf(doc.palette[idx] ?? [0, 0, 0])}`;
});
canvas.addEventListener("mouseleave", () => ($("stat-cursor").textContent = "—"));

/* 键盘：Ctrl+Tab 切换文档 */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    const { docs, activeIndex } = getState();
    if (docs.length) setState({ activeIndex: (activeIndex + 1) % docs.length });
  }
});

/* ---------------------------------------------------------------- 引擎状态 */
health()
  .then((h) => {
    const dev = h.ai_device?.active;
    const label = dev === "cuda" ? "CUDA" : dev === "dml" ? "DirectML" : dev === "cpu" ? "CPU" : "";
    const models = Object.values(h.models).filter(Boolean).length;
    $("engine-status").textContent =
      `引擎 ${h.status} · 模型 ${models}/3${label ? ` · ${label}` : ""}`;
  })
  .catch(() => ($("engine-status").textContent = "引擎离线（start_engine.bat）"));

/* ---------------------------------------------------------------- 会话自动保存/恢复（M3） */
const urlParams = new URLSearchParams(location.search);
const demoMode = urlParams.has("demo");
const agentDemo = urlParams.has("agentDemo"); // MCP Agent 控制蒙版视觉验收
const sessionDisabled = demoMode; // demo 自动建档不覆盖用户会话；测试可手动 __pf.autosave()
const SESSION_KEY = "pf.session.v1";

interface SessionLayer {
  id: string;
  name: string;
  kind: PFLayer["kind"];
  visible: boolean;
  data: Array<[number, CellOverride]>;
  bg?: boolean; // M5-0：自动拆分出的背景层
}
interface SessionDocV1 {
  name: string;
  jobId: string;
  w: number;
  h: number;
  lineart?: LineartAsset; // 线稿文档资产（源分辨率 PNG）
  palette: [number, number, number][];
  paletteBase?: [number, number, number][];
  paletteFx?: PaletteFx;
  recipe?: Partial<RecipeParams>;
  presetName?: string;
  fill: string; // Int32Array → base64
  ink: string | null;
  alpha?: string; // M5-0：源 alpha 网格（Uint8 0/1 → base64）
  inkVisible?: boolean;
  inkOpacity?: number;
  layers: SessionLayer[];
  activeLayerId: string;
  baseLayerId: string;
  sourceUrl?: string;
  colorsUsed?: number;
  ms?: number;
  blank?: boolean;
  srcPath?: string;
  srcKey?: string; // M5.2：IndexedDB 里的上传源文件引用（恢复后仍可重转换）
  dirty?: boolean;
  projectName?: string;
  projectSavedAt?: number;
  detailMask?: string; // M4：细节标记位图（Uint8 → base64，1=标记）
}
interface SessionPayload {
  version: 1;
  savedAt: number;
  docs: SessionDocV1[];
  ui?: {
    activeIndex?: number; zoom?: number; showGrid?: boolean; preset?: string; size?: number;
    applyAll?: boolean; underlay?: number; paletteSort?: PaletteSort; detailLevel?: number;
  };
}

function i32ToB64(arr: Int32Array): string {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let out = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    out += String.fromCharCode(...u8.subarray(i, i + CH));
  }
  return btoa(out);
}
function b64ToI32(b64: string): Int32Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Int32Array(u8.buffer);
}
function u8ToB64(u8: Uint8Array): string {
  let out = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) out += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(out);
}
function maskToB64(mask: Set<number>, n: number): string {
  const u8 = new Uint8Array(n);
  for (const i of mask) if (i >= 0 && i < n) u8[i] = 1;
  return u8ToB64(u8);
}
function b64ToMask(b64: string, n: number): Set<number> {
  const bin = atob(b64);
  const out = new Set<number>();
  for (let i = 0; i < Math.min(n, bin.length); i++) if (bin.charCodeAt(i)) out.add(i);
  return out;
}
/** base64 → 长度 n 的 0/1 位图（越界补 0）。 */
function b64ToU8(b64: string, n: number): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(n);
  for (let i = 0; i < Math.min(n, bin.length); i++) out[i] = bin.charCodeAt(i) ? 1 : 0;
  return out;
}

function serializeDoc(doc: EditorDoc, includeSource: boolean): SessionDocV1 {
  return {
    name: doc.name,
    lineart: doc.lineart,
    jobId: doc.jobId,
    w: doc.w,
    h: doc.h,
    palette: doc.palette,
    paletteBase: doc.paletteBase,
    paletteFx: doc.paletteFx,
    recipe: doc.recipe,
    presetName: doc.presetName,
    fill: i32ToB64(doc.fill),
    ink: doc.ink ? i32ToB64(doc.ink) : null,
    alpha: doc.alpha ? u8ToB64(doc.alpha) : undefined,
    inkVisible: doc.inkVisible,
    inkOpacity: doc.inkOpacity,
    layers: doc.layers.map((l) => ({
      id: l.id, name: l.name, kind: l.kind, visible: l.visible,
      data: [...l.data.entries()] as Array<[number, CellOverride]>,
      bg: l.bg,
    })),
    activeLayerId: doc.activeLayerId,
    baseLayerId: doc.baseLayerId,
    sourceUrl: includeSource ? doc.sourceUrl : "",
    colorsUsed: doc.colorsUsed,
    ms: doc.ms,
    blank: doc.blank,
    srcPath: doc.src?.path,
    srcKey: doc.src?.key,
    dirty: doc.dirty,
    projectName: doc.projectName,
    projectSavedAt: doc.projectSavedAt,
    detailMask: doc.detailMask?.size ? maskToB64(doc.detailMask, doc.w * doc.h) : undefined,
  };
}

function sessionPayload(includeSource: boolean): SessionPayload {
  const s = getState();
  return {
    version: 1,
    savedAt: Date.now(),
    docs: s.docs.map((d) => serializeDoc(d, includeSource)),
    ui: {
      activeIndex: s.activeIndex, zoom: s.zoom, showGrid: s.showGrid,
      preset: s.preset, size: s.size, applyAll: s.applyAll,
      underlay: s.underlay, paletteSort: s.paletteSort, detailLevel: s.detailLevel,
    },
  };
}

let sessionBusy = false;
/** 自动保存：localStorage 轻量副本 + 引擎 web/session.json 全量（含源图缩略）。 */
async function autosave(force = false): Promise<void> {
  if ((!force && sessionDisabled) || !getState().docs.length || sessionBusy) return;
  sessionBusy = true;
  try {
    const full = sessionPayload(true);
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(full));
    } catch {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(sessionPayload(false)));
        console.warn("会话超出 localStorage 配额，已丢弃源图缩略");
      } catch {
        localStorage.removeItem(SESSION_KEY);
        console.warn("会话过大，localStorage 备份已跳过（引擎 session.json 仍可恢复）");
      }
    }
    await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: full }),
    });
  } catch (err) {
    console.warn("会话保存失败", err);
  } finally {
    sessionBusy = false;
  }
}

function isSession(v: unknown): v is SessionPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as SessionPayload;
  return o.version === 1 && Array.isArray(o.docs);
}

async function loadSessionPayload(): Promise<SessionPayload | null> {
  try {
    const res = await fetch("/api/session");
    if (res.ok) {
      const data: unknown = await res.json();
      if (isSession(data)) return data;
    }
  } catch { /* 引擎离线 → 退回 localStorage */ }
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (isSession(data)) return data;
    }
  } catch { /* 忽略损坏副本 */ }
  return null;
}

function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  void clearSources(); // 上传源文件一并清掉，避免 IndexedDB 里留孤儿
  void fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { version: 1, savedAt: Date.now(), docs: [] } }),
  }).catch(() => { /* 引擎离线时忽略 */ });
}

function normalizeFill(arr: Int32Array, n: number): Int32Array {
  if (arr.length === n) return arr;
  const out = new Int32Array(n).fill(-1);
  out.set(arr.subarray(0, Math.min(n, arr.length)));
  return out;
}

/** 恢复文档时的配方：预设默认 + 会话覆盖。
 *
 * M5.3：`brightContrast` 曾因默认值 0.5 造成全局过曝/偏色，bug 期间保存的会话里带着这个值。
 * 该参数只在 bug 存在的那段时间出现过，所以恢复时把非 0 一律归零（用户可在面板重新调）。
 */
function restoredRecipe(preset: string, saved: Partial<RecipeParams> | undefined): RecipeParams {
  const r = { ...presetRecipe(preset), ...(saved ?? {}) };
  if (r.brightContrast) r.brightContrast = 0;
  return r;
}

async function restoreDoc(sd: SessionDocV1, sourceOverride?: File): Promise<EditorDoc> {
  let src: EditorDoc["src"];
  if (sourceOverride) src = { file: sourceOverride, key: sd.srcKey };
  else if (sd.srcPath) src = { path: sd.srcPath };
  else if (sd.srcKey) {
    const f = await getSource(sd.srcKey);
    if (f) src = { file: f, key: sd.srcKey };
  }
  if (sd.lineart) {
    // 线稿文档：无网格/图层/调色板，直接恢复源分辨率图
    const preset = sd.presetName ?? "lineart";
    const doc = addDoc({
      name: sd.name ?? "未命名",
      lineart: sd.lineart,
      jobId: sd.jobId ?? "",
      w: sd.lineart.width,
      h: sd.lineart.height,
      palette: [],
      paletteBase: [],
      paletteFx: { ...ZERO_PALETTE_FX },
      recipe: restoredRecipe(preset, sd.recipe),
      presetName: preset,
      fill: new Int32Array(0),
      ink: null,
      alpha: null,
      inkVisible: false,
      inkOpacity: 1,
      layers: [],
      activeLayerId: "",
      baseLayerId: "",
      sourceUrl: sd.sourceUrl ?? "",
      colorsUsed: 0,
      ms: sd.ms ?? 0,
      src,
    });
    doc.dirty = sd.dirty ?? false;
    doc.projectName = sd.projectName;
    doc.projectSavedAt = sd.projectSavedAt;
    return doc;
  }
  const layers: PFLayer[] = sd.layers.map((sl) => {
    const layer = mkLayer(sl.name, sl.kind);
    layer.visible = sl.visible;
    if (sl.bg) layer.bg = true;
    for (const [i, ov] of sl.data) layer.data.set(i, { ...ov });
    return layer;
  });
  if (!layers.length) layers.push(mkLayer("画布层", "canvas"));
  const idMap = new Map(sd.layers.map((sl, k) => [sl.id, layers[k].id]));
  const baseLayerId = idMap.get(sd.baseLayerId) ?? layers[0].id;
  const activeLayerId = idMap.get(sd.activeLayerId) ?? baseLayerId;
  const preset = sd.presetName ?? "photo";
  const palette = sd.palette ?? [[0, 0, 0] as [number, number, number]];
  const n = Math.max(1, sd.w) * Math.max(1, sd.h);
  const doc = addDoc({
    name: sd.name ?? "未命名",
    jobId: sd.jobId ?? "",
    w: Math.max(1, sd.w),
    h: Math.max(1, sd.h),
    palette,
    paletteBase: sd.paletteBase ?? palette,
    paletteFx: sd.paletteFx ?? { ...ZERO_PALETTE_FX },
    recipe: restoredRecipe(preset, sd.recipe),
    presetName: preset,
    fill: normalizeFill(b64ToI32(sd.fill ?? ""), n),
    ink: sd.ink ? normalizeFill(b64ToI32(sd.ink), n) : null,
    alpha: sd.alpha ? b64ToU8(sd.alpha, n) : null,
    inkVisible: sd.inkVisible ?? true,
    inkOpacity: sd.inkOpacity ?? 1,
    layers,
    activeLayerId,
    baseLayerId,
    sourceUrl: sd.sourceUrl ?? "",
    colorsUsed: sd.colorsUsed ?? 0,
    ms: sd.ms ?? 0,
    src,
    blank: sd.blank ?? false,
    detailMask: sd.detailMask ? b64ToMask(sd.detailMask, n) : undefined,
  });
  doc.dirty = sd.dirty ?? false;
  doc.projectName = sd.projectName;
  doc.projectSavedAt = sd.projectSavedAt;
  return doc;
}

async function restoreSession(s: SessionPayload): Promise<void> {
  for (const sd of s.docs) await restoreDoc(sd);
  const docs = getState().docs;
  if (!docs.length) return;
  const ui = s.ui ?? {};
  const idx = Math.min(Math.max(0, ui.activeIndex ?? docs.length - 1), docs.length - 1);
  setState({
    activeIndex: idx,
    zoom: typeof ui.zoom === "number" ? Math.max(0.05, Math.min(24, ui.zoom)) : getState().zoom,
    showGrid: ui.showGrid ?? true,
    preset: ui.preset ?? getState().preset,
    size: ui.size ?? getState().size,
    applyAll: ui.applyAll ?? false,
    underlay: ui.underlay ?? 0,
    paletteSort: ui.paletteSort ?? "usage",
    detailLevel: ui.detailLevel ?? 1,
  });
  $("grid").setAttribute("aria-pressed", String(getState().showGrid));
  ($("underlay") as HTMLInputElement).value = String(getState().underlay);
  invalidateBitmaps(activeDoc() ?? docs[0]);
  redrawCanvas();
  setStatus(`已恢复 ${docs.length} 个文档`);
}

/* ------------------------------------------------ 0.3.0 项目文件（.pixelforge） */

/** 项目文件：单个文档的完整快照 + 内嵌源图（保存后可换机器继续编辑）。 */
interface ProjectFileV1 {
  type: "pixelforge-project";
  version: 1;
  appVersion: string;
  createdAt: number;
  updatedAt: number;
  doc: SessionDocV1;
  source?: { name: string; mime: string; data: string }; // base64（无 data: 前缀）
  sourcePath?: string;
  ui?: { zoom?: number; showGrid?: boolean; underlay?: number };
}

/** File System Access 的最小类型（浏览器支持不一，缺省回退下载/文件选择）。 */
interface FsWritable { write(data: Blob | string): Promise<void>; close(): Promise<void> }
interface FsFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FsWritable>;
  queryPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}
type SaveFilePicker = (opts?: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<FsFileHandle>;

interface RecentProject {
  id: string; // 文件名小写：同一文件视为同一项目
  name: string;
  docName: string;
  w: number;
  h: number;
  savedAt: number;
}

const RECENT_KEY = "pf.projects.v1";
const RECENT_MAX = 12;
/** 文件句柄只能存活于本会话（浏览器不允许跨刷新持久化），刷新后需重新选择文件。 */
const projectHandles = new Map<string, FsFileHandle>();
let relocateDoc: EditorDoc | null = null;

function recentIdOf(name: string): string {
  return name.toLowerCase();
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
}

function projectFileName(doc: EditorDoc): string {
  const base = (doc.projectName ?? doc.name).replace(/\.pixelforge$/i, "");
  return `${safeFileName(base)}.pixelforge`;
}

async function fileToB64(file: File): Promise<string> {
  return u8ToB64(new Uint8Array(await file.arrayBuffer()));
}

function b64ToFile(src: { name: string; mime: string; data: string }): File {
  const bin = atob(src.data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new File([u8], src.name || "source.png", { type: src.mime || "image/png" });
}

function loadRecent(): RecentProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is RecentProject =>
      !!r && typeof r.id === "string" && typeof r.name === "string"
      && typeof r.docName === "string" && typeof r.savedAt === "number"
      && typeof r.w === "number" && typeof r.h === "number");
  } catch {
    return [];
  }
}

function saveRecent(list: RecentProject[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); }
  catch { /* 配额满时忽略（最近列表不是关键数据） */ }
}

function addRecent(entry: RecentProject): void {
  const list = loadRecent().filter((r) => r.id !== entry.id);
  list.unshift(entry);
  saveRecent(list);
}

function removeRecent(id: string): void {
  projectHandles.delete(id);
  saveRecent(loadRecent().filter((r) => r.id !== id));
}

function renderRecent(): void {
  const list = $("recent-projects");
  list.textContent = "";
  const recent = loadRecent();
  if (!recent.length) {
    const hint = document.createElement("p");
    hint.className = "pf-project-empty";
    hint.textContent = "还没有保存过项目。保存后会出现在这里。";
    list.appendChild(hint);
    return;
  }
  for (const r of recent) {
    const row = document.createElement("div");
    row.className = "pf-project";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    const name = document.createElement("span");
    name.className = "pf-project-name";
    name.textContent = r.name;
    const meta = document.createElement("span");
    meta.className = "pf-project-meta";
    meta.textContent = `${r.docName} · ${r.w}×${r.h} · ${new Date(r.savedAt).toLocaleDateString()}`;
    const del = document.createElement("button");
    del.className = "pf-ly-del";
    del.textContent = "×";
    del.title = "从最近项目中移除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRecent(r.id);
      renderRecent();
    });
    row.append(name, meta, del);
    const open = () => { void openRecentProject(r); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    list.appendChild(row);
  }
}

async function buildProjectFile(doc: EditorDoc): Promise<ProjectFileV1> {
  const srcFile = doc.src?.file;
  const now = Date.now();
  return {
    type: "pixelforge-project",
    version: 1,
    appVersion: __APP_VERSION__,
    createdAt: doc.projectSavedAt ?? now,
    updatedAt: now,
    doc: serializeDoc(doc, true),
    source: srcFile
      ? { name: srcFile.name, mime: srcFile.type || "image/png", data: await fileToB64(srcFile) }
      : undefined,
    sourcePath: doc.src?.path,
    ui: { zoom: getState().zoom, showGrid: getState().showGrid, underlay: getState().underlay },
  };
}

/** 文件句柄权限：已授予返回 true；未授予时尝试请求（需用户手势）。 */
async function handlePermission(handle: FsFileHandle, mode: "read" | "readwrite"): Promise<boolean> {
  try {
    if (handle.queryPermission && (await handle.queryPermission({ mode })) === "granted") return true;
    if (handle.requestPermission) return (await handle.requestPermission({ mode })) === "granted";
  } catch {
    return false;
  }
  return true;
}

async function writeProject(handle: FsFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(new Blob([text], { type: "application/json" }));
  await writable.close();
}

/** 保存当前文档：优先原位写入（File System Access），否则下载文件。 */
async function saveProject(asNew = false): Promise<void> {
  const doc = activeDoc();
  if (!doc) { setStatus("没有打开的文档"); return; }
  let payload: ProjectFileV1;
  try {
    payload = await buildProjectFile(doc);
  } catch (err) {
    setStatus(`读取源图失败: ${(err as Error).message}`);
    return;
  }
  const text = JSON.stringify(payload) + "\n";
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  let handle = asNew || !doc.projectName ? null : projectHandles.get(recentIdOf(doc.projectName)) ?? null;
  if (!handle && picker) {
    try {
      handle = await picker({
        suggestedName: projectFileName(doc),
        types: [{ description: "PixelForge project", accept: { "application/json": [".pixelforge"] } }],
      });
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return; // 用户取消
      console.warn("项目另存为弹窗不可用，回退下载", err);
    }
  }
  let savedName: string;
  try {
    if (handle) {
      if (!(await handlePermission(handle, "readwrite"))) {
        setStatus("项目文件没有写入权限");
        return;
      }
      await writeProject(handle, text);
      savedName = handle.name;
    } else {
      savedName = projectFileName(doc);
      downloadText(savedName, text);
    }
  } catch (err) {
    setStatus(`保存失败: ${(err as Error).message}`);
    return;
  }
  doc.projectName = savedName;
  doc.projectSavedAt = Date.now();
  doc.dirty = false;
  if (handle) projectHandles.set(recentIdOf(savedName), handle);
  addRecent({
    id: recentIdOf(savedName), name: savedName, docName: doc.name,
    w: doc.w, h: doc.h, savedAt: doc.projectSavedAt,
  });
  updateDoc(doc, {});
  renderRecent();
  setStatus(`已保存项目 ${savedName}`);
}

/** 结构校验：坏文件直接拒绝，避免把非法尺寸/色板灌进编辑器。 */
function validProjectDoc(doc: SessionDocV1): boolean {
  if (!doc || typeof doc !== "object") return false;
  const w = Number(doc.w), h = Number(doc.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > 4096 || h > 4096) return false;
  if (w * h > 4_000_000) return false;
  if (doc.lineart) return typeof doc.lineart.url === "string";
  return Array.isArray(doc.layers) && Array.isArray(doc.palette) && typeof doc.fill === "string";
}

async function openProjectFile(file: File, handle?: FsFileHandle): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setStatus("项目文件不是合法 JSON");
    return;
  }
  const pf = parsed as Partial<ProjectFileV1>;
  if (!pf || pf.type !== "pixelforge-project" || pf.version !== 1 || !pf.doc || !validProjectDoc(pf.doc)) {
    setStatus("不是有效的 PixelForge 项目文件");
    return;
  }
  let source: File | undefined;
  try {
    source = pf.source?.data ? b64ToFile(pf.source) : undefined;
  } catch {
    setStatus("项目文件中的源图数据已损坏");
    return;
  }
  try {
    const doc = await restoreDoc(pf.doc, source);
    doc.projectName = file.name;
    doc.projectSavedAt = pf.updatedAt ?? Date.now();
    doc.dirty = false;
    if (source) await persistSource(doc, source);
    const id = recentIdOf(file.name);
    if (handle) projectHandles.set(id, handle);
    addRecent({ id, name: file.name, docName: doc.name, w: doc.w, h: doc.h, savedAt: doc.projectSavedAt });
    renderRecent();
    const ui = pf.ui;
    setState({
      zoom: doc.lineart
        ? Math.max(0.05, Math.min(8, ui?.zoom ?? fitZoomForLineart(doc.w, doc.h)))
        : Math.max(1, Math.min(24, ui?.zoom ?? fitZoomFor(doc.w, doc.h))),
      showGrid: ui?.showGrid ?? getState().showGrid,
      underlay: ui?.underlay ?? getState().underlay,
    });
    $("grid").setAttribute("aria-pressed", String(getState().showGrid));
    ($("underlay") as HTMLInputElement).value = String(getState().underlay);
    invalidateBitmaps(doc);
    redrawCanvas();
    setStatus(`已打开项目 ${file.name} · ${doc.name}`);
    if (!doc.blank && !doc.src) void offerRelocateSource(doc);
  } catch (err) {
    setStatus(`打开项目失败: ${(err as Error).message}`);
  }
}

async function openRecentProject(r: RecentProject): Promise<void> {
  const handle = projectHandles.get(r.id);
  if (handle) {
    if (!(await handlePermission(handle, "read"))) {
      setStatus("没有读取项目文件的权限");
      return;
    }
    try {
      await openProjectFile(await handle.getFile(), handle);
      return;
    } catch (err) {
      setStatus(`打开项目失败: ${(err as Error).message}`);
      return;
    }
  }
  ($("projectsdlg") as HTMLDialogElement).close();
  setStatus(`请选择项目文件「${r.name}」`);
  ($("project-input") as HTMLInputElement).click();
}

/** 项目/会话恢复的文档缺少源图时，提示重新绑定（可重转换、可导出引擎线稿）。 */
async function offerRelocateSource(doc: EditorDoc): Promise<void> {
  if (!doc || doc.blank || doc.src) return;
  const en = getLocale() === "en-US";
  const ok = await confirmDialog({
    title: t("缺少源图"),
    message: en
      ? `“${doc.name}” has no source image, so it cannot be reconverted or export engine line art. Choose the source image now?`
      : `「${doc.name}」缺少源图，无法重转换或导出引擎线稿。现在选择源图吗？`,
    okText: t("选择源图…"),
    cancelText: t("取消"),
  });
  if (!ok) return;
  relocateDoc = doc;
  ($("source-input") as HTMLInputElement).click();
}

function mountProjects(): void {
  const dlg = $("projectsdlg") as HTMLDialogElement;
  $("projects-btn").addEventListener("click", () => { renderRecent(); dlg.showModal(); });
  $("project-save").addEventListener("click", () => void saveProject(false));
  $("proj-close").addEventListener("click", () => dlg.close());
  $("proj-saveas").addEventListener("click", () => { dlg.close(); void saveProject(true); });
  $("proj-browse").addEventListener("click", () => {
    dlg.close();
    ($("project-input") as HTMLInputElement).click();
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  ($("project-input") as HTMLInputElement).addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void openProjectFile(file);
  });

  ($("source-input") as HTMLInputElement).addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    const doc = relocateDoc ?? activeDoc();
    relocateDoc = null;
    if (!file || !doc) return;
    doc.src = { file };
    await persistSource(doc, file);
    updateDoc(doc, {}); // 刷新标签/图层/面板
    setStatus(`已重新绑定源图 ${file.name} · 可重新转换`);
  });

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      void saveProject(e.shiftKey);
    } else if (key === "o") {
      e.preventDefault();
      ($("project-input") as HTMLInputElement).click();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (!getState().docs.some((d) => d.dirty)) return;
    e.preventDefault();
    e.returnValue = "";
  });

  renderRecent();
}

let pendingSession: SessionPayload | null = null;
async function offerRestore(): Promise<void> {
  if (sessionDisabled || getState().docs.length) return;
  const data = await loadSessionPayload();
  if (!data || !data.docs.length || getState().docs.length) return;
  pendingSession = data;
  $("restore-info").textContent =
    `发现 ${data.docs.length} 个文档（自动保存于 ${new Date(data.savedAt).toLocaleString()}）。`;
  ($("restoredlg") as HTMLDialogElement).showModal();
}
const restoreDlg = $("restoredlg") as HTMLDialogElement;
$("restore-yes").addEventListener("click", () => {
  const s = pendingSession;
  pendingSession = null;
  restoreDlg.close();
  if (s) void restoreSession(s);
});
$("restore-no").addEventListener("click", () => {
  pendingSession = null;
  clearSession();
  restoreDlg.close();
});

if (!sessionDisabled) {
  window.setInterval(() => void autosave(), 30000);
  window.addEventListener("pagehide", () => void autosave());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void autosave();
  });
}

/* demo 模式：?demo=1 自动从引擎拉仓库内的合成测试图建档（自动化验收/快速体验） */
if (demoMode) {
  const demos: Array<[string, string, string, number]> = [
    ["scene", "tests/golden/scene.png", "photo", 64],
    ["scene_48", "tests/golden/scene.png", "photo", 48],
    ["rgba", "tests/golden/inputs/rgba_test.png", "illustration", 64],
  ];
  (async () => {
    for (const [name, path, preset, size] of demos) {
      try {
        const r = await convertPath(path, preset, size);
        await docFromResponse(name, r, { path }, presetRecipe(preset), preset);
      } catch (err) {
        setStatus(`demo 失败: ${(err as Error).message}`);
      }
    }
  })();
}

/* ------------------------------------------------ 图层操作事件：提取/删除/激活由面板派发 */
document.addEventListener("pf:extract-layer", ((e: CustomEvent<"cut" | "copy">) => {
  const doc = activeDoc();
  if (doc) extractSelectionToLayer(doc, e.detail);
}) as EventListener);
document.addEventListener("pf:delete-layer", ((e: CustomEvent<string>) => {
  const doc = activeDoc();
  if (doc) deleteLayer(doc, e.detail);
}) as EventListener);
document.addEventListener("pf:set-active-layer", ((e: CustomEvent<string>) => {
  const doc = activeDoc();
  if (!doc) return;
  updateDoc(doc, { activeLayerId: e.detail });
}) as EventListener);

/* M5-6 标签右键菜单：复制配方到全部 / 导出此文档 */
document.addEventListener("pf:recipes-to-all", ((e: CustomEvent<number>) => {
  const src = getState().docs[e.detail];
  if (!src) return;
  const targets = getState().docs.filter((d) => !d.blank && d.src);
  if (!targets.length) { setStatus("没有可应用的源图文档"); return; }
  for (const d of targets) {
    updateDoc(d, {
      recipe: { ...src.recipe, seedColors: src.recipe.seedColors.map((c) => [...c] as [number, number, number]) },
      presetName: src.presetName,
    });
  }
  setStatus(`正在把「${src.name}」的配方应用到 ${targets.length} 个文档…`);
  void (async () => {
    for (const d of targets) await reconvertDoc(d);
    redrawCanvas();
    setStatus(`已把「${src.name}」的配方应用到 ${targets.length} 个文档`);
  })();
}) as EventListener);

document.addEventListener("pf:export-doc", ((e: CustomEvent<number>) => {
  const doc = getState().docs[e.detail];
  if (!doc) return;
  setActive(e.detail);
  openExport();
}) as EventListener);

/* 装配面板 */
mountTabs($("tabs"));
mountLayers($("layers"));
mountPalette($("palette"), $("pal-count"), $("pal-custom"), $("pal-sort") as HTMLSelectElement);
mountTools();
mountHistory($("history"));
mountColorLib($("colorlib"));
mountSettings();
mountHelp();
mountOnboarding();
mountDialogs();
mountProjects();
mountMcpUi({ demo: agentDemo });
mountJobSync(applyJobUpdate);
redrawCanvas();
void offerRestore();

/* 开发调试句柄（自动化验收用） */
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as Record<string, unknown>).__pf = {
    getState, activeDoc,
    autosave: () => autosave(true),
    importFiles: (files: File[]) => importFiles(files, "测试导入"),
    /** M5-0 验收：合成导出的透明/不透明像素计数。 */
    composeStats: (transparent: boolean) => {
      const d = activeDoc();
      if (!d || d.lineart) return null;
      const cv = compositeDoc(d, { transparent });
      const px = cv.getContext("2d")!.getImageData(0, 0, d.w, d.h).data;
      let t = 0;
      for (let i = 0; i < d.w * d.h; i++) if (px[i * 4 + 3] === 0) t++;
      return { total: d.w * d.h, transparent: t, opaque: d.w * d.h - t };
    },
    /** M5-0 验收：源 alpha 网格统计。 */
    alphaStats: () => {
      const d = activeDoc();
      if (!d?.alpha) return null;
      let t = 0;
      for (let i = 0; i < d.alpha.length; i++) if (!d.alpha[i]) t++;
      return { total: d.alpha.length, transparent: t };
    },
    /** M5-0 验收：图层栈摘要。 */
    layerSummary: () => {
      const d = activeDoc();
      return d
        ? d.layers.map((l) => ({ name: l.name, visible: l.visible, bg: !!l.bg, base: l.id === d.baseLayerId }))
        : null;
    },
    /** MCP UI 验收：打开管理窗 / 控制蒙版 / 读取 Agent 状态。 */
    mcp: {
      open: openMcpManager,
      control: setAgentControl,
      agents: getMcpAgents,
      sync: () => ({
        lastJobUpdate,
        docs: getState().docs.map((d) => ({
          name: d.name,
          jobId: d.jobId,
          revision: d.jobRevision,
          fill0: d.fill[0],
        })),
      }),
    },
    settings: { open: openSettings, current: getSettings },
  };
}
