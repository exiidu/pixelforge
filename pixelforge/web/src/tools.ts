/** M2 编辑闭环 + M2.5 工具扩编 + M2.7 图层化：所有绘制/移动/翻转作用于当前活动层。
 * 手改是各逻辑层 data 的稀疏 diff，历史栈记录跨层 steps + 图层增删（设计文档 §3/§5）。 */

import {
  activeDoc, activeLayer, getState, setState, updateDoc, layerById,
  layerFillAt, layerInkAt, mkLayer,
  type CellOp, type CellOverride, type EditorDoc, type HistEntry, type HistStep, type Rect,
} from "./store";
import { invalidateBitmaps } from "./render";
import { transformPalette } from "./color";

type Layer = "fill" | "ink";

export function effFill(doc: EditorDoc, i: number): number {
  const l = activeLayer(doc);
  return l ? layerFillAt(doc, l, i) : -1;
}
export function effInk(doc: EditorDoc, i: number): number {
  const l = activeLayer(doc);
  return l ? layerInkAt(doc, l, i) : -1;
}

/** 文档合成可见 fill（自顶向下取第一层非透明格）——取色/磁吸等按所见取。 */
export function compositeFill(doc: EditorDoc, i: number): number {
  for (let k = doc.layers.length - 1; k >= 0; k--) {
    const l = doc.layers[k];
    if (!l.visible) continue;
    const f = layerFillAt(doc, l, i);
    if (f >= 0) return f;
  }
  return -1;
}

/* ------------------------------------------------------------- 选区 scope */

function inGrid(doc: EditorDoc, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < doc.w && y < doc.h;
}

/** 格子是否在选区作用域内（无选区 = 整个画布）。 */
export function scopeHas(doc: EditorDoc, x: number, y: number): boolean {
  if (!inGrid(doc, x, y)) return false;
  const sel = getState().selection;
  if (!sel) return true;
  if (sel.kind === "rect") {
    const r = sel.rect;
    return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  }
  return sel.cells.has(y * doc.w + x);
}

/** 选区内全部格子（无选区 = 整个画布）。 */
export function scopeCells(doc: EditorDoc): Array<[number, number]> {
  const sel = getState().selection;
  if (!sel) {
    const out: Array<[number, number]> = [];
    for (let y = 0; y < doc.h; y++)
      for (let x = 0; x < doc.w; x++) out.push([x, y]);
    return out;
  }
  if (sel.kind === "rect") {
    const out: Array<[number, number]> = [];
    for (let y = sel.rect.y0; y <= sel.rect.y1; y++)
      for (let x = sel.rect.x0; x <= sel.rect.x1; x++) out.push([x, y]);
    return out;
  }
  return [...sel.cells].map((i) => [i % doc.w, Math.floor(i / doc.w)] as [number, number]);
}

/* ------------------------------------------------------------- 手改提交（steps） */

/** 应用某 step 的 ops 到指定图层 data（mode=before 恢复旧值，after 落新值）。 */
function applyLayerOps(layer: { data: Map<number, CellOverride> }, ops: CellOp[], mode: "before" | "after"): void {
  for (const op of ops) {
    const v = mode === "before" ? op.before : op.after;
    if (v === undefined) layer.data.delete(op.i);
    else layer.data.set(op.i, v);
  }
}

/** 提交一组操作（可跨图层 steps）到历史。steps 的执行顺序即记录顺序。
 *  entry.layerFx：操作新建/删除的图层（redo/undo 各自还原图层存在性）。 */
function pushEntry(doc: EditorDoc, entry: HistEntry): void {
  if (entry.steps.reduce((n, s) => n + s.ops.length, 0) === 0 && !entry.layerFx) return;
  for (const s of entry.steps) {
    const layer = layerById(doc, s.layerId);
    if (layer) applyLayerOps(layer, s.ops, "after");
  }
  doc.history.undo.push(entry);
  if (doc.history.undo.length > 100) doc.history.undo.shift();
  doc.history.redo.length = 0;
  doc.dirty = true;
  invalidateBitmaps(doc);
  updateDoc(doc, {});
}

function commit(doc: EditorDoc, label: string, steps: HistStep[], layerFx?: HistEntry["layerFx"]): void {
  pushEntry(doc, { label, steps, layerFx });
}

function commitLayer(doc: EditorDoc, layerId: string, ops: CellOp[], label: string): void {
  commit(doc, label, [{ layerId, ops }]);
}

/** 笔画缓冲：一笔（pointerdown→up）只产生一条历史。 */
let strokeOps: CellOp[] | null = null;
const strokeIndex = new Map<number, number>(); // 格号 → strokeOps 下标
let strokeLayerId = "";

export function beginStroke(doc: EditorDoc): void {
  strokeOps = [];
  strokeIndex.clear();
  strokeLayerId = activeLayer(doc)?.id ?? "";
}

export function endStroke(doc: EditorDoc, label: string): void {
  if (!strokeOps) return;
  const ops = strokeOps;
  strokeOps = null;
  strokeIndex.clear();
  commitLayer(doc, strokeLayerId, ops, label);
}

/** 落格起点版本（base 覆盖文档现状）。 */
function stampFrom(
  _doc: EditorDoc, _i: number, layer: Layer, value: number | "erase", ops: CellOp[],
  base?: CellOverride,
): void {
  const cur = base;
  let after: CellOverride | undefined;
  if (layer === "fill") {
    if (value === "erase") {
      if (cur?.fill === undefined) return;
      after = cur.ink !== undefined ? { ink: cur.ink } : undefined;
    } else {
      if (cur?.fill === value) return;
      after = { ...(cur ?? {}), fill: value };
    }
  } else {
    const v = value === "erase" ? -1 : value;
    if (cur?.ink === v) return;
    after = { ...(cur ?? {}), ink: v };
  }
  ops.push({ i: _i, before: cur ? { ...cur } : undefined, after });
}

/** 对称映射：一个格子按对称模式展开成最多 4 个。 */
export function symmetryCells(doc: EditorDoc, x: number, y: number): Array<[number, number]> {
  const { symmetry } = getState();
  const out: Array<[number, number]> = [[x, y]];
  const mx = doc.w - 1 - x, my = doc.h - 1 - y;
  if (symmetry === "h" || symmetry === "quad") out.push([mx, y]);
  if (symmetry === "v" || symmetry === "quad") out.push([x, my]);
  if (symmetry === "quad") out.push([mx, my]);
  return out;
}

/** 展开对称 + 选区裁剪 + 去重。 */
function expandCells(doc: EditorDoc, cells: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const seen = new Set<number>();
  for (const [x, y] of cells) {
    for (const [sx, sy] of symmetryCells(doc, x, y)) {
      if (!scopeHas(doc, sx, sy)) continue;
      const i = sy * doc.w + sx;
      if (!seen.has(i)) {
        seen.add(i);
        out.push([sx, sy]);
      }
    }
  }
  return out;
}

/** 笔刷方形笔尖（1-4px）。 */
export function brushTipCells(x: number, y: number, size: number): Array<[number, number]> {
  const s = Math.max(1, Math.min(4, Math.round(size)));
  if (s === 1) return [[x, y]];
  const off = Math.floor((s - 1) / 2);
  const out: Array<[number, number]> = [];
  for (let dy = 0; dy < s; dy++)
    for (let dx = 0; dx < s; dx++) out.push([x - off + dx, y - off + dy]);
  return out;
}

/** pixel-perfect 线（Aseprite 同款）：Bresenham 后剔除拐角双像素。 */
export function pixelPerfectLine(
  x0: number, y0: number, x1: number, y1: number,
): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    raw.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  const out: Array<[number, number]> = [];
  for (let k = 0; k < raw.length; k++) {
    const prev = out[out.length - 1], next = raw[k + 1];
    if (prev && next && Math.abs(prev[0] - next[0]) === 1 && Math.abs(prev[1] - next[1]) === 1) {
      const corner =
        (prev[1] === raw[k][1] && next[0] === raw[k][0])
        || (prev[0] === raw[k][0] && next[1] === raw[k][1]);
      if (corner) continue; // 拐角双像素剔除
    }
    out.push(raw[k]);
  }
  return out;
}

/** 普通直线（形状工具用，保留阶梯）。 */
function plainLine(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return out;
}

function rectPerimeter(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let x = x0; x <= x1; x++) { out.push([x, y0]); out.push([x, y1]); }
  for (let y = y0; y <= y1; y++) { out.push([x0, y]); out.push([x1, y]); }
  return out;
}

function rectArea(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

function ellipseOutline(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const w = x1 - x0, h = y1 - y0;
  if (w <= 1 || h <= 1) return rectPerimeter(x0, y0, x1, y1);
  const a = w / 2, b = h / 2, cx = (x0 + x1) / 2;
  const out: Array<[number, number]> = [];
  for (let yy = 0; yy <= h; yy++) {
    const t = (yy - b) / b;
    const xe = a * Math.sqrt(Math.max(0, 1 - t * t));
    const xa = Math.round(cx - xe), xb = Math.round(cx + xe);
    out.push([xa, y0 + yy]);
    if (xb !== xa) out.push([xb, y0 + yy]);
  }
  return out;
}

function ellipseArea(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const w = x1 - x0, h = y1 - y0;
  if (w <= 1 || h <= 1) return rectArea(x0, y0, x1, y1);
  const a = w / 2, b = h / 2, cx = (x0 + x1) / 2;
  const out: Array<[number, number]> = [];
  for (let yy = 0; yy <= h; yy++) {
    const t = (yy - b) / b;
    const xe = a * Math.sqrt(Math.max(0, 1 - t * t));
    const xa = Math.round(cx - xe), xb = Math.round(cx + xe);
    for (let x = xa; x <= xb; x++) out.push([x, y0 + yy]);
  }
  return out;
}

/** 形状工具的格子集合（含 Shift 填充变体）。 */
export function shapeCells(
  kind: "line" | "rect" | "ellipse", x0: number, y0: number, x1: number, y1: number,
  filled: boolean,
): Array<[number, number]> {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  if (kind === "line") return plainLine(x0, y0, x1, y1);
  if (kind === "rect") return filled ? rectArea(xa, ya, xb, yb) : rectPerimeter(xa, ya, xb, yb);
  return filled ? ellipseArea(xa, ya, xb, yb) : ellipseOutline(xa, ya, xb, yb);
}

/* ------------------------------------------------------------- 形状实时预览 */

let shapePrev: { layerId: string; saved: Map<number, CellOverride | undefined> } | null = null;

/** 应用形状预览（不入历史；先还原上一次预览再盖新的）。 */
export function shapePreviewApply(
  doc: EditorDoc, cells: Array<[number, number]>, _layer: Layer, value: number,
): void {
  const l = activeLayer(doc);
  if (!l) return;
  if (shapePrev) {
    for (const [i, ov] of shapePrev.saved) {
      if (ov === undefined) l.data.delete(i);
      else l.data.set(i, ov);
    }
  }
  const expanded = expandCells(doc, cells);
  const saved = new Map<number, CellOverride | undefined>();
  for (const [x, y] of expanded) {
    const i = y * doc.w + x;
    if (!saved.has(i)) {
      const cur = l.data.get(i);
      saved.set(i, cur ? { ...cur } : undefined);
    }
  }
  for (const [x, y] of expanded) {
    const i = y * doc.w + x;
    const cur = saved.get(i);
    const after: CellOverride = { ...(cur ?? {}) };
    after.fill = value;
    l.data.set(i, after);
  }
  shapePrev = { layerId: l.id, saved };
  invalidateBitmaps(doc);
  updateDoc(doc, {});
}

/** 还原预览（提交前调用，最终结果由 paintCells 落历史）。 */
export function shapePreviewEnd(doc: EditorDoc): void {
  const l = shapePrev ? layerById(doc, shapePrev.layerId) : null;
  if (!shapePrev || !l) { shapePrev = null; return; }
  for (const [i, ov] of shapePrev.saved) {
    if (ov === undefined) l.data.delete(i);
    else l.data.set(i, ov);
  }
  shapePrev = null;
  invalidateBitmaps(doc);
  updateDoc(doc, {});
}

/** 一次成型提交（油漆桶/形状/选区操作用）：含对称、选区裁剪。写活动层 fill 槽。 */
export function paintCells(
  doc: EditorDoc, cells: Array<[number, number]>, _layer: Layer, value: number | "erase",
  label: string,
): void {
  const l = activeLayer(doc);
  if (!l) return;
  const ops: CellOp[] = [];
  const seen = new Set<number>();
  for (const [x, y] of expandCells(doc, cells)) {
    const i = y * doc.w + x;
    if (seen.has(i)) continue;
    seen.add(i);
    const cur = l.data.get(i);
    stampFrom(doc, i, "fill", value, ops, cur ? { ...cur } : undefined);
  }
  commitLayer(doc, l.id, ops, label);
}

/** 把 cells 追加进当前笔画（铅笔/橡皮；须在 beginStroke 之后）。写笔画起始层的 fill 槽。
 *  返回本次实际变更的格号（供实时笔迹做脏格补丁）。 */
export function stampCells(
  doc: EditorDoc, cells: Array<[number, number]>, _layer: Layer, value: number | "erase",
): number[] {
  const changed: number[] = [];
  if (!strokeOps) return changed;
  const l = layerById(doc, strokeLayerId);
  if (!l) return changed;
  for (const [x, y] of expandCells(doc, cells)) {
    const i = y * doc.w + x;
    const k = strokeIndex.get(i);
    const before = k !== undefined ? strokeOps[k].before : (l.data.get(i) ? { ...l.data.get(i) } : undefined);
    const cur = k !== undefined ? (strokeOps[k].after ? { ...strokeOps[k].after } : undefined) : before;
    const tmp: CellOp[] = [];
    stampFrom(doc, i, "fill", value, tmp, cur);
    if (!tmp.length) continue;
    const op: CellOp = { i, before, after: tmp[0].after };
    if (k !== undefined) strokeOps[k] = op;
    else { strokeIndex.set(i, strokeOps.length); strokeOps.push(op); }
    if (op.after === undefined) l.data.delete(i);
    else l.data.set(i, op.after);
    changed.push(i);
  }
  return changed;
}

/* ------------------------------------------------------------- 油漆桶 */

export function bucketFill(
  doc: EditorDoc, sx: number, sy: number, _layer: Layer, value: number | "erase",
  label: string,
): void {
  if (!scopeHas(doc, sx, sy)) return;
  const seedI = sy * doc.w + sx;
  const target = effFill(doc, seedI);
  if (value !== "erase" && value === target) return;
  const visited = new Set<number>([seedI]);
  const queue: number[] = [seedI];
  const cells: Array<[number, number]> = [];
  while (queue.length) {
    const i = queue.pop()!;
    cells.push([i % doc.w, Math.floor(i / doc.w)]);
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const x = i % doc.w + ox, y = Math.floor(i / doc.w) + oy;
      if (!scopeHas(doc, x, y)) continue;
      const j = y * doc.w + x;
      if (visited.has(j) || effFill(doc, j) !== target) continue;
      visited.add(j);
      queue.push(j);
    }
  }
  paintCells(doc, cells, "fill", value, label);
}

/* ------------------------------------------------------------- 移动工具（仅活动层） */

/** 移动收尾：有选区→移动活动层选区内容；无选区→平移活动层全部手改数据。 */
export function finishMove(doc: EditorDoc, dx: number, dy: number): boolean {
  if (dx === 0 && dy === 0) return false;
  if (getState().selection) return moveScopeContent(doc, dx, dy);
  return moveLayerData(doc, dx, dy);
}

/** 移动活动层选区内容：内容从活动层挖走（原位透明），写到目标格。只动活动层。 */
function moveScopeContent(doc: EditorDoc, dx: number, dy: number): boolean {
  const l = activeLayer(doc);
  if (!l) return false;
  const grab: Array<{ i: number; fill: number; ink: number }> = [];
  for (const [x, y] of scopeCells(doc)) {
    const i = y * doc.w + x;
    const fill = layerFillAt(doc, l, i);
    const ink = layerInkAt(doc, l, i);
    if (fill < 0 && ink < 0) continue; // 活动层该格无内容
    grab.push({ i, fill, ink });
  }
  if (!grab.length) return false;

  const clearOps: CellOp[] = [];
  for (const g of grab) {
    const cur = l.data.get(g.i);
    const before = cur ? { ...cur } : undefined;
    const after: CellOverride = { ...(cur ?? {}) };
    if (g.fill >= 0) after.fill = -1; // 遮罩 base：原位不再显现
    if (g.ink >= 0) after.ink = -1;
    l.data.set(g.i, after);
    clearOps.push({ i: g.i, before, after });
  }

  const writeOps: CellOp[] = [];
  for (const g of grab) {
    const x = g.i % doc.w + dx, y = Math.floor(g.i / doc.w) + dy;
    if (!inGrid(doc, x, y)) continue;
    const j = y * doc.w + x;
    const cur = l.data.get(j);
    const before = cur ? { ...cur } : undefined;
    const after: CellOverride = { ...(cur ?? {}) };
    if (g.fill >= 0) after.fill = g.fill;
    if (g.ink >= 0) after.ink = g.ink;
    l.data.set(j, after);
    writeOps.push({ i: j, before, after });
  }
  commit(doc, "移动", [{ layerId: l.id, ops: clearOps }, { layerId: l.id, ops: writeOps }]);

  // 选区跟随平移
  const sel = getState().selection;
  if (sel?.kind === "rect") {
    const r = sel.rect;
    setState({ selection: { kind: "rect", rect: { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy } } });
  } else if (sel?.kind === "poly") {
    const moved = new Set<number>();
    const path: Array<[number, number]> = sel.path.map(([x, y]) => [x + dx, y + dy]);
    for (const i of sel.cells) {
      const x = i % doc.w + dx, y = Math.floor(i / doc.w) + dy;
      if (inGrid(doc, x, y)) moved.add(y * doc.w + x);
    }
    setState({ selection: { kind: "poly", cells: moved, bounds: {
      x0: sel.bounds.x0 + dx, y0: sel.bounds.y0 + dy,
      x1: sel.bounds.x1 + dx, y1: sel.bounds.y1 + dy,
    }, path } });
  }
  return true;
}

/** 无选区：整个活动层的 data 平移（算法 base 不动）。 */
function moveLayerData(doc: EditorDoc, dx: number, dy: number): boolean {
  const l = activeLayer(doc);
  if (!l || l.data.size === 0) return false;
  const old = new Map(l.data);
  const now = new Map<number, CellOverride>();
  for (const [i, ov] of old) {
    const x = i % doc.w + dx, y = Math.floor(i / doc.w) + dy;
    if (!inGrid(doc, x, y)) continue;
    now.set(y * doc.w + x, { ...ov });
  }
  const ops: CellOp[] = [];
  const touched = new Set<number>([...old.keys(), ...now.keys()]);
  for (const i of touched) {
    const b = old.get(i), a = now.get(i);
    const same = (!b && !a) || (!!b && !!a && b.fill === a.fill && b.ink === a.ink);
    if (!same) ops.push({ i, before: b ? { ...b } : undefined, after: a ? { ...a } : undefined });
  }
  commitLayer(doc, l.id, ops, "移动");
  return ops.length > 0;
}

/* ------------------------------------------------------------- 选区内容翻转（仅矩形，作用于活动层） */

export function flipSelection(doc: EditorDoc, dir: "h" | "v"): boolean {
  const sel = getState().selection;
  const l = activeLayer(doc);
  if (!sel || sel.kind !== "rect" || !l) return false;
  const r = sel.rect;
  const grab = scopeCells(doc).map(([x, y]) => {
    const i = y * doc.w + x;
    return {
      x, y,
      fill: layerFillAt(doc, l, i),
      ink: layerInkAt(doc, l, i),
    };
  });
  const ops: CellOp[] = [];
  for (const g of grab) {
    const nx = dir === "h" ? r.x1 - (g.x - r.x0) : g.x;
    const ny = dir === "v" ? r.y1 - (g.y - r.y0) : g.y;
    const i = ny * doc.w + nx;
    const cur = l.data.get(i);
    const after: CellOverride = { ...(cur ?? {}) };
    if (g.fill >= 0) after.fill = g.fill;
    if (g.ink >= 0) after.ink = g.ink;
    ops.push({ i, before: cur ? { ...cur } : undefined, after });
  }
  commitLayer(doc, l.id, ops, dir === "h" ? "水平翻转" : "垂直翻转");
  return ops.length > 0;
}

/* ------------------------------------------------------------- 磁力套索 */

/** 磁力吸附：raw 格附近 ±2px 找颜色对比最强的格（贴色边）；平坦区保持原位。 */
export function magneticSnap(doc: EditorDoc, rawX: number, rawY: number): [number, number] {
  const edgeScore = (x: number, y: number): number => {
    if (!inGrid(doc, x, y)) return -1;
    const c = doc.palette[compositeFill(doc, y * doc.w + x)];
    if (!c) return 0;
    let score = 0;
    for (const [ox, oy] of [[1, 0], [0, 1]] as const) {
      const nx2 = x + ox, ny2 = y + oy;
      if (!inGrid(doc, nx2, ny2)) continue;
      const d = doc.palette[compositeFill(doc, ny2 * doc.w + nx2)];
      if (!d) continue;
      const dr = c[0] - d[0], dg = c[1] - d[1], db = c[2] - d[2];
      score = Math.max(score, 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
    }
    return score;
  };
  // 以原始格为基准，按距离升序扫描，严格更大才替换 → 近处同分不抢、远处高分的边胜出
  let best: [number, number] = [rawX, rawY];
  let bestScore = edgeScore(rawX, rawY);
  const offs: Array<[number, number]> = [];
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      if (dx || dy) offs.push([dx, dy]);
  offs.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])));
  for (const [dx, dy] of offs) {
    const s = edgeScore(rawX + dx, rawY + dy);
    if (s > bestScore) { bestScore = s; best = [rawX + dx, rawY + dy]; }
  }
  return best;
}

/** 射线法：路径多边形（顶点=格中心）内部的格子集合 + 路径本身。 */
export function polygonCells(doc: EditorDoc, path: Array<[number, number]>): {
  cells: Set<number>; bounds: Rect;
} {
  const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]);
  const bounds: Rect = {
    x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)),
    x1: Math.min(doc.w - 1, Math.max(...xs)), y1: Math.min(doc.h - 1, Math.max(...ys)),
  };
  const verts = path.map(([x, y]) => [x + 0.5, y + 0.5]);
  const cells = new Set<number>();
  for (const [px, py] of path) cells.add(py * doc.w + px); // 路径本身必选
  for (let y = bounds.y0; y <= bounds.y1; y++) {
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const i = y * doc.w + x;
      if (cells.has(i)) continue;
      const cx = x + 0.5, cy = y + 0.5;
      let inside = false;
      for (let a = 0, b = verts.length - 1; a < verts.length; b = a++) {
        const [ax, ay] = verts[a], [bx, by] = verts[b];
        if ((ay > cy) !== (by > cy)
          && cx < ((bx - ax) * (cy - ay)) / (by - ay) + ax) inside = !inside;
      }
      if (inside) cells.add(i);
    }
  }
  return { cells, bounds };
}

/* ------------------------------------------------------------- 选区复制到偏移 */

/** Shift+方向键：把活动层选区内容复制一份到 (dx,dy)，原处保留。 */
export function copySelectionToOffset(doc: EditorDoc, dx: number, dy: number): boolean {
  if (dx === 0 && dy === 0) return false;
  const l = activeLayer(doc);
  if (!l) return false;
  const ops: CellOp[] = [];
  for (const [x, y] of scopeCells(doc)) {
    const i = y * doc.w + x;
    const fill = layerFillAt(doc, l, i);
    const ink = layerInkAt(doc, l, i);
    if (fill < 0 && ink < 0) continue;
    const nx = x + dx, ny = y + dy;
    if (!inGrid(doc, nx, ny)) continue;
    const j = ny * doc.w + nx;
    const cur = l.data.get(j);
    const after: CellOverride = { ...(cur ?? {}) };
    if (fill >= 0) after.fill = fill;
    if (ink >= 0) after.ink = ink;
    ops.push({ i: j, before: cur ? { ...cur } : undefined, after });
  }
  commitLayer(doc, l.id, ops, "复制");
  return ops.length > 0;
}

/* ------------------------------------------------------------- 选区提取为独立图层 */

export type ExtractMode = "cut" | "copy";

/** 选区内容提取为新图层（插入到活动层上方并激活）；cut=原位清空。历史含图层增删还原。 */
export function extractSelectionToLayer(doc: EditorDoc, mode: ExtractMode): boolean {
  const l = activeLayer(doc);
  if (!l || !getState().selection) return false;
  const grab: Array<{ i: number; fill: number; ink: number }> = [];
  for (const [x, y] of scopeCells(doc)) {
    const i = y * doc.w + x;
    const fill = layerFillAt(doc, l, i);
    const ink = layerInkAt(doc, l, i);
    if (fill < 0 && ink < 0) continue;
    grab.push({ i, fill, ink });
  }
  if (!grab.length) { setState({ selection: null }); return false; }

  const at = doc.layers.findIndex((x) => x.id === l.id);
  const nl = mkLayer(`图层 ${doc.layers.filter((x) => x.kind === "normal").length + 1}`, "normal");
  doc.layers.splice(at + 1, 0, nl); // 提交前先入栈，让 writeOps 能落到该层
  const writeOps: CellOp[] = [];
  for (const g of grab) {
    const after: CellOverride = {};
    if (g.fill >= 0) after.fill = g.fill;
    if (g.ink >= 0) after.ink = g.ink;
    nl.data.set(g.i, { ...after });
    writeOps.push({ i: g.i, before: undefined, after });
  }
  const steps: HistStep[] = [{ layerId: nl.id, ops: writeOps }];
  if (mode === "cut") {
    const clearOps: CellOp[] = [];
    for (const g of grab) {
      const cur = l.data.get(g.i);
      const after: CellOverride = { ...(cur ?? {}) };
      if (g.fill >= 0) after.fill = -1;
      if (g.ink >= 0) after.ink = -1;
      clearOps.push({ i: g.i, before: cur ? { ...cur } : undefined, after });
    }
    steps.push({ layerId: l.id, ops: clearOps });
  }
  commit(doc, mode === "cut" ? "剪切到新图层" : "复制到新图层", steps, {
    id: nl.id, name: nl.name, kind: nl.kind, at: Math.min(at + 1, doc.layers.length), on: "redo",
  });
  doc.activeLayerId = nl.id;
  setState({ selection: null });
  return true;
}

/* ------------------------------------------------------------- 删除图层（基础层不可删） */

export function deleteLayer(doc: EditorDoc, id: string): boolean {
  if (id === doc.baseLayerId || doc.layers.length <= 1) return false;
  const l = layerById(doc, id);
  if (!l) return false;
  const at = doc.layers.findIndex((x) => x.id === id);
  const ops: CellOp[] = [];
  for (const [i, ov] of l.data) ops.push({ i, before: { ...ov }, after: undefined });
  doc.layers = doc.layers.filter((x) => x.id !== id);
  if (doc.activeLayerId === id) {
    doc.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? doc.baseLayerId;
  }
  pushEntry(doc, {
    label: "删除图层",
    steps: [{ layerId: id, ops }],
    layerFx: { id: l.id, name: l.name, kind: l.kind, at, on: "undo" },
  });
  return true;
}

/* ------------------------------------------------------------- 撤销 / 重做 */

function entryApplyFx(doc: EditorDoc, entry: HistEntry, dir: "undo" | "redo"): void {
  const fx = entry.layerFx;
  if (!fx) return;
  const shouldRemove = (dir === "undo" && fx.on === "redo") || (dir === "redo" && fx.on === "undo");
  if (shouldRemove) {
    doc.layers = doc.layers.filter((x) => x.id !== fx.id);
    if (doc.activeLayerId === fx.id) doc.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? doc.baseLayerId;
  } else {
    if (!layerById(doc, fx.id)) {
      const l = mkLayer(fx.name, fx.kind);
      l.id = fx.id;
      doc.layers.splice(Math.max(0, Math.min(fx.at, doc.layers.length)), 0, l);
    }
  }
  // 图层存在性变化后，重建引用（undo 里 steps 还会写该层 data）
}

export function undo(): void {
  const doc = activeDoc();
  const entry = doc?.history.undo.pop();
  if (!doc || !entry) return;
  // 先做图层增删（顺序在前，保证 steps 落到的层存在）
  entryApplyFx(doc, entry, "undo");
  for (const step of [...entry.steps].reverse()) {
    const l = layerById(doc, step.layerId);
    if (l) applyLayerOps(l, step.ops, "before");
  }
  // 移除因 undo 而清空的层（提取层）：仅在 on=redo 的层、undo 后已空时删除——由 entryApplyFx 处理
  doc.history.redo.push(entry);
  invalidateBitmaps(doc);
  updateDoc(doc, {});
}

export function redo(): void {
  const doc = activeDoc();
  const entry = doc?.history.redo.pop();
  if (!doc || !entry) return;
  entryApplyFx(doc, entry, "redo");
  for (const step of entry.steps) {
    const l = layerById(doc, step.layerId);
    if (l) applyLayerOps(l, step.ops, "after");
  }
  doc.history.undo.push(entry);
  invalidateBitmaps(doc);
  updateDoc(doc, {});
}

/** 历史面板跳转：pos = 保留的前缀 undo 步数（0 = 回到最初）。 */
export function jumpHistory(doc: EditorDoc, pos: number): void {
  while (doc.history.undo.length > pos) undo();
  while (doc.history.undo.length < pos && doc.history.redo.length) redo();
}

/* ------------------------------------------------------------- 颜色入库 */

/** 把 RGB 并入文档调色板（已有则复用），返回索引。 */
export function ensureDocColor(doc: EditorDoc, rgb: [number, number, number]): number {
  const k = doc.palette.findIndex(
    (c) => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2],
  );
  if (k >= 0) return k;
  // 同步写入变换基准，保证色板变换后新增色也跟着变、索引仍然对齐
  doc.paletteBase.push([rgb[0], rgb[1], rgb[2]]);
  doc.palette = transformPalette(doc.paletteBase, doc.paletteFx);
  updateDoc(doc, {});
  return doc.palette.length - 1;
}