/** 多文档状态 + 极简 pub/sub（设计文档 §2）。M2.7：逻辑图层栈模型。 */

import type { PaletteFx } from "./color";

/** 一层里某个格子的内容槽：fill/ink 为调色板索引；-1 = 该槽透明（ink 原有，fill 于 M2.7 引入）。
 *  alpha 为不透明度（0=透明 1=不透明），与 fill/ink 正交；未定义 = 回落到本层 base 的 alpha。
 *  槽未定义 = 回落到本层 base（仅 base 拥有层有此语义）。 */
export interface CellOverride { fill?: number; ink?: number; alpha?: number }

/** 逻辑图层：data 为该层手绘/提取内容（优先于 base）；仅 base 拥有层（文件层/画布层）有引擎 base。 */
export interface PFLayer {
  id: string;
  name: string;                 // "画布层" | "文件层" | "背景层" | "图层 N"
  kind: "canvas" | "file" | "normal";
  visible: boolean;
  data: Map<number, CellOverride>;
  bg?: boolean;                 // M5-0：导入自动拆分出的背景层（透明格补边缘主色）
}

export type Tool = "move" | "select" | "lasso" | "pencil" | "eraser" | "bucket" | "picker"
  | "line" | "rect" | "ellipse" | "hand" | "detail" | "alpha";
export type Symmetry = "off" | "h" | "v" | "quad";
export type PaletteSort = "usage" | "hue" | "light" | "sat";
/** 矩形选区（格子坐标，含端点，已归一化 x0<=x1, y0<=y1）。 */
export interface Rect { x0: number; y0: number; x1: number; y1: number }
/** 选区：矩形或磁力套索多边形（cells=命中的格子号集合，path=吸附路径供渲染）。 */
export type Selection =
  | { kind: "rect"; rect: Rect }
  | { kind: "poly"; cells: Set<number>; bounds: Rect; path: Array<[number, number]> };
/** 一次手改的稀疏 diff：override[i] 由 before → after（undefined = 无覆盖）。 */
export interface CellOp { i: number; before: CellOverride | undefined; after: CellOverride | undefined }
/** 一步操作可跨多个图层（如剪切到新层）：steps 按执行顺序记录。 */
export interface HistStep { layerId: string; ops: CellOp[] }
/** 历史条目中伴随的图层增删：extract=redo 重建（undo 移除）；delete=undo 重建（redo 移除）。 */
export interface HistLayerFx {
  id: string; name: string; kind: PFLayer["kind"]; at: number; on: "redo" | "undo";
}
/** base 层局部补丁（M4 细节重算）：撤销/重做时恢复 fill/ink 与色板尾部追加。 */
export interface BasePatch {
  cells: number[];
  beforeFill: number[];
  afterFill: number[];
  beforeInk: Array<number | null>; // null = 该文档无墨线层
  afterInk: Array<number | null>;
  paletteBefore: [number, number, number][];
  paletteAfter: [number, number, number][];
}
/** 索引整表重映射（M5.2/B3 色板导入）：最近色映射多对一、不可逆，撤销必须快照 before/after。 */
export interface IndexRemap {
  beforeFill: Int32Array; afterFill: Int32Array;
  beforeInk: Int32Array | null; afterInk: Int32Array | null;
  paletteBefore: [number, number, number][];
  paletteAfter: [number, number, number][];
}
export interface HistEntry {
  label: string;
  steps: HistStep[];
  layerFx?: HistLayerFx;
  base?: BasePatch;
  /** M5-3：调色板整体替换（单色编辑/导入色板）；撤销/重做恢复 paletteBase 与显示色板。 */
  palette?: { before: [number, number, number][]; after: [number, number, number][] };
  /** M5.2/B3：索引整表重映射（含 base fill/ink 快照）。 */
  remap?: IndexRemap;
}

/** 每文档独立配方参数（M3 参数面板回显/编辑；送引擎时转成 overrides）。 */
export interface RecipeParams {
  edge: number;        // sampling.weights.edge
  dark: number;        // sampling.weights.dark
  contrast: number;    // sampling.weights.contrast
  brightContrast: number;  // M5.3 preprocess.levels.bright_contrast：亮部对比增强（只动亮区）
  softRatio: number;   // sampling.soft_ratio
  mergeDelta: number;  // sampling.merge_delta
  paletteSource: "extract" | "builtin";
  paletteRef: string;  // builtin 名：gameboy | cga16 | gray8 | paper
  maxColors: number;   // extract 的 k
  paletteLock: boolean;                    // M5-4：重转换强制保留当前色板
  seedColors: [number, number, number][];  // 锁定的颜色（≤32，追加到新色板尾部）
  ink: boolean;        // ink.enable
  lineart: "off" | "xdog" | "onnx";
}

/** 预设的默认配方参数（新建文档/切换预设时初始化）。 */
export function presetRecipe(preset: string): RecipeParams {
  const base: RecipeParams = {
    edge: 2.0, dark: 1.5, contrast: 1.0,
    brightContrast: 0, // 与引擎 DEFAULT_RECIPE 默认一致；illustration 预设 0.5（天空/云分层）
    softRatio: 1.4, mergeDelta: 0.05,
    paletteSource: "extract", paletteRef: "gameboy", maxColors: 64,
    paletteLock: false, seedColors: [],
    ink: false, lineart: "off",
  };
  if (preset === "illustration") {
    return { ...base, maxColors: 32, ink: true, lineart: "xdog" };
  }
  if (preset === "lineart") {
    return { ...base, paletteSource: "builtin", paletteRef: "paper", maxColors: 1, ink: true, lineart: "onnx" };
  }
  return base;
}

/** 线稿文档资产：源分辨率黑线白纸 PNG（直接显示/导出，不走像素网格）。 */
export interface LineartAsset {
  url: string;                 // data:image/png;base64,...
  width: number;
  height: number;
  mode: string;                // onnx | xdog
}

export interface EditorDoc {
  id: string;
  name: string;
  /** 线稿文档：非像素网格，只读高分辨率视图；fill/ink/layers/palette 为空。 */
  lineart?: LineartAsset;
  jobId: string;
  /** MCP-3B：当前文档对应服务端 job 的 revision（WS 更新按此去重）。 */
  jobRevision?: number;
  w: number;
  h: number;
  palette: [number, number, number][];     // 当前显示色板（含 paletteFx 变换）
  paletteBase: [number, number, number][]; // 引擎原始色板（变换基准，索引与格号对齐）
  paletteFx: PaletteFx;                    // 整板 OKLab 变换（0 = 不改板）
  recipe: RecipeParams; // 每文档独立配方（转换参数改动只作用于本文件）
  presetName: string;   // 该文档的预设（photo/illustration/lineart），重转换时作为基底配方
  /** 引擎底色/墨线（base 拥有层的引擎输出，reconvert 时整体替换）。 */
  fill: Int32Array;
  ink: Int32Array | null; // -1 = 非墨线格
  /** M5-0：源 alpha 网格（0=透明 1=不透明，长度 w*h）；null = 无源透明信息（导出回退边缘泛洪）。 */
  alpha: Uint8Array | null;
  inkVisible: boolean;    // 墨线叠加开关（并入文件层后由面板徽章/线稿导出使用）
  inkOpacity: number;
  /** 逻辑图层栈：index0 = 最底（画布层）。 */
  layers: PFLayer[];
  activeLayerId: string;
  /** 拥有 fill/ink base 的层 id（"文件层"或画布层（空白画布））。 */
  baseLayerId: string;
  sourceUrl: string; // 源图缩略（对比浮层）
  colorsUsed: number;
  ms: number;
  dirty: boolean;
  /** 重转换用源；空 = 新建画布。key = IndexedDB 里的源文件引用（会话恢复用）。 */
  src?: { file?: File; path?: string; key?: string };
  blank?: boolean; // true = 纯手绘画布（无源图，不参与转换）
  /** 0.3.0：最近一次保存的项目文件名与时间（用于原位保存与未保存判断）。 */
  projectName?: string;
  projectSavedAt?: number;
  /** M4：细节重算标记（网格格号；仅当前文档，重算成功后清空）。 */
  detailMask?: Set<number>;
  history: { undo: HistEntry[]; redo: HistEntry[] };
  /** 重转换前的调色板快照（手改索引重绑基准；内部字段，不序列化）。 */
  _palBefore?: [number, number, number][];
}

export interface AppState {
  docs: EditorDoc[];
  activeIndex: number;
  zoom: number;
  showGrid: boolean;
  compare: boolean;
  colorIndex: number;
  preset: string;
  size: number;
  tool: Tool;
  symmetry: Symmetry;
  selection: Selection | null;
  brushSize: number; // 1-4px 方形笔尖（铅笔/橡皮）
  customColors: string[]; // 全局自定义色架（hex，跨文档，localStorage 持久化）
  paletteSort: PaletteSort;
  applyAll: boolean; // M3：配方改动广播到全部标签
  underlay: number;  // M3：描图底图不透明度 0-100（源图垫在透明格下方）
  detailLevel: number; // M4：细节增强强度档 0=轻 1=中 2=强
}

interface State extends AppState {
  _docSeq: number;
}

function loadCustomColors(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("pf.customColors") ?? "[]");
    return Array.isArray(v) ? v.filter((c) => typeof c === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

let state: State = {
  docs: [],
  activeIndex: -1,
  zoom: 6,
  showGrid: true,
  compare: false,
  colorIndex: 0,
  preset: "photo",
  size: 64,
  tool: "pencil",
  symmetry: "off",
  selection: null,
  brushSize: 1,
  customColors: loadCustomColors(),
  paletteSort: "usage",
  applyAll: false,
  underlay: 0,
  detailLevel: 1,
  _docSeq: 0,
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function setState(patch: Partial<AppState>): void {
  if (patch.customColors) {
    try { localStorage.setItem("pf.customColors", JSON.stringify(patch.customColors)); } catch { /* 忽略 */ }
  }
  state = { ...state, ...patch };
  listeners.forEach((f) => f());
}

export function activeDoc(): EditorDoc | null {
  return state.activeIndex >= 0 ? state.docs[state.activeIndex] : null;
}

/* ------------------------------------------------ 图层 helper */

let layerSeq = 0;

/** 新建逻辑图层（空 data）。 */
export function mkLayer(name: string, kind: PFLayer["kind"]): PFLayer {
  return { id: `ly${++layerSeq}`, name, kind, visible: true, data: new Map() };
}

export function activeLayer(doc: EditorDoc): PFLayer | null {
  return doc.layers.find((l) => l.id === doc.activeLayerId) ?? null;
}

export function layerById(doc: EditorDoc, id: string): PFLayer | null {
  return doc.layers.find((l) => l.id === id) ?? null;
}

export function setActiveLayer(doc: EditorDoc, layerId: string): EditorDoc {
  if (doc.activeLayerId === layerId || !layerById(doc, layerId)) return doc;
  updateDoc(doc, { activeLayerId: layerId });
  return doc;
}

/** 该层某格的颜色槽值（-1 = 透明；data 优先，回落到 base（仅 base 拥有层））。 */
export function layerFillAt(doc: EditorDoc, layer: PFLayer, i: number): number {
  const ov = layer.data.get(i);
  if (ov?.fill !== undefined) return ov.fill;
  return layer.id === doc.baseLayerId ? (doc.fill[i] ?? -1) : -1;
}
export function layerInkAt(doc: EditorDoc, layer: PFLayer, i: number): number {
  const ov = layer.data.get(i);
  if (ov?.ink !== undefined) return ov.ink;
  if (layer.id === doc.baseLayerId && doc.ink) return doc.ink[i];
  return -1;
}

/** 该层某格的不透明度（0=透明，1=不透明）。data 的 alpha 优先；
 *  base 拥有层回落到 doc.alpha（无源透明信息 = 全不透明），其余层默认不透明。 */
export function layerAlphaAt(doc: EditorDoc, layer: PFLayer, i: number): number {
  const ov = layer.data.get(i);
  if (ov?.alpha !== undefined) return ov.alpha;
  if (layer.id === doc.baseLayerId && doc.alpha) return doc.alpha[i] ? 1 : 0;
  return 1;
}

/** 文档是否携带透明信息（源 alpha 或任一层存在 alpha 覆盖）。
 *  为 false 时导出「透明背景」沿用旧的边缘泛洪回退（非透明素材行为不变）。 */
export function docHasAlpha(doc: EditorDoc): boolean {
  if (doc.alpha) return true;
  for (const l of doc.layers) {
    for (const ov of l.data.values()) if (ov.alpha !== undefined) return true;
  }
  return false;
}

export function addDoc(doc: Omit<EditorDoc, "id" | "dirty" | "history">): EditorDoc {
  const full: EditorDoc = {
    ...doc,
    id: `doc${++state._docSeq}`,
    dirty: false,
    history: { undo: [], redo: [] },
  };
  state.docs = [...state.docs, full];
  setState({ activeIndex: state.docs.length - 1, selection: null });
  return full;
}

export function updateDoc(doc: EditorDoc, patch: Partial<EditorDoc>): void {
  Object.assign(doc, patch);
  state.docs = [...state.docs]; // 触发引用更新
  listeners.forEach((f) => f());
}

export function closeDoc(index: number): void {
  const docs = state.docs.filter((_, i) => i !== index);
  const activeIndex =
    state.activeIndex === index
      ? Math.min(index, docs.length - 1)
      : state.activeIndex > index
        ? state.activeIndex - 1
        : state.activeIndex;
  setState({ docs, activeIndex, selection: null });
}

export function setActive(index: number): void {
  if (index !== state.activeIndex) setState({ activeIndex: index, selection: null });
}

/** M5-6：拖拽重排标签（保持活动文档不变）。 */
export function moveDoc(from: number, to: number): void {
  const { docs, activeIndex } = state;
  if (from === to || from < 0 || to < 0 || from >= docs.length || to >= docs.length) return;
  const activeId = docs[activeIndex]?.id;
  const next = [...docs];
  const [d] = next.splice(from, 1);
  next.splice(to, 0, d);
  const newActive = next.findIndex((x) => x.id === activeId);
  setState({ docs: next, activeIndex: newActive >= 0 ? newActive : 0 });
}

/** M5-6：关闭 index 右侧的全部标签。 */
export function closeDocsToRight(index: number): number {
  const { docs } = state;
  if (index < 0 || index >= docs.length - 1) return 0;
  const keep = docs.slice(0, index + 1);
  setState({ docs: keep, activeIndex: Math.min(state.activeIndex, keep.length - 1), selection: null });
  return docs.length - keep.length;
}

/** M5-6：除 index 外全部关闭。 */
export function closeOtherDocs(index: number): number {
  const { docs } = state;
  if (index < 0 || index >= docs.length || docs.length <= 1) return 0;
  setState({ docs: [docs[index]], activeIndex: 0, selection: null });
  return docs.length - 1;
}

export function hexOf(c: [number, number, number]): string {
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}