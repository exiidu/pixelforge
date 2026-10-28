/** 双语化：静态文案按中文原文查表，动态文案按正则规则翻译。
 *
 * 做法：不逐个改渲染调用点，而是在 DOM 上做本地化——
 * - 英文：遍历文本节点与 title/placeholder/aria-label/alt，按“完整文本”查表或走动态规则；
 * - 中文：用 WeakMap 记下原文，切回中文时还原；
 * - 运行期新增的内容由 MutationObserver 补译。
 * 这样既不改动已有渲染逻辑，也不会误翻用户输入（只有命中词条才会替换）。
 */
import { EN } from "./i18n-dict";

export type Locale = "zh-CN" | "en-US";

const HAN = /[\u4e00-\u9fff]/;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "PRE", "TEXTAREA"]);
const ATTRS = ["title", "placeholder", "aria-label", "alt"] as const;

type DynRule = readonly [RegExp, string | ((m: RegExpMatchArray) => string)];

/** 动态文案（源码里的模板字符串在运行时会插值，无法整句查表，按渲染后的形状匹配）。
 *  顺序敏感：更具体的规则放在前面。 */
const DYN: DynRule[] = [
  [/^(.+) 正在控制编辑器$/, "$1 is controlling the editor"],
  [/^正在执行：任务$/, "Running: task"],
  [/^正在执行：(.+)$/, "Running: $1"],
  [/^(\d+)×(\d+) 线稿$/, "Line art $1×$2"],
  [/^(.+) · (\d+)×(\d+) px · 线稿 ([A-Za-z]+) · 网格 ([\d.]+)ms$/, "$1 · $2×$3 px · line art $4 · grid $5ms"],
  [/^(.+) · (\d+)×(\d+) px · 线稿 ([A-Za-z]+)$/, "$1 · $2×$3 px · line art $4"],
  [/^(.+) · (\d+)×(\d+) · (\d+) 色 · 网格 ([\d.]+)ms$/, "$1 · $2×$3 · $4 colors · grid $5ms"],
  [/^(.+) · (\d+)×(\d+) · 空白画布 (\d+) 色$/, "$1 · $2×$3 · blank canvas, $4 colors"],
  [/^(.+) · 引擎线稿 (\d+)×(\d+)$/, "$1 · engine line art $2×$3"],
  [/^(.+) · 无墨线可预览$/, "$1 · no ink layer to preview"],
  [/^(.+) · 无源图（会话恢复的上传文件），无法重转换$/, "$1 · no source image (file restored from session), cannot reconvert"],
  [/^(.+) · 无源图（空白画布）$/, "$1 · no source image (blank canvas)"],
  [/^(.+) · 无源图，无法提取线稿$/, "$1 · no source image, cannot extract line art"],
  [/^(.+) · 空白画布，不参与转换$/, "$1 · blank canvas, not converted"],
  [/^(.+) · 线稿 (\d+)×(\d+)$/, "$1 · line art $2×$3"],
  [/^(.+) · 线稿加载中…$/, "$1 · loading line art…"],
  [/^(.+) · 线稿提取中…$/, "$1 · extracting line art…"],
  [/^(.+) · 左键选用 · 右键删除$/, "$1 · click to select · right-click to delete"],
  [/^(.+) 点击激活$/, "$1 — click to activate"],
  [/^(.+)（基础层：含引擎转换内容，不可删除）$/, "$1 (base layer: engine output, cannot be deleted)"],
  [/^(.+)（自动拆分：透明格补边缘主色，默认隐藏=真透明；可显隐\/删除）$/, "$1 (auto-split: transparent cells filled with edge color, hidden = true transparency; can toggle/delete)"],
  [/^图层 (\d+)$/, "$1 layers"],
  [/^(\d+) 色$/, "$1 colors"],
  [/^导入色板 (\d+) 色$/, "Imported palette: $1 colors"],
  [/^已导入色板 (\d+) 色 · 按最近色重映射 (\d+) 格（Ctrl\+Z 可撤销）$/, "Imported $1 colors · remapped $2 cells to nearest colors (Ctrl+Z to undo)"],
  [/^已删除色架颜色 (.+)$/, "Removed swatch color $1"],
  [/^已恢复 (\d+) 个文档$/, "Restored $1 documents"],
  [/^已恢复 (#[0-9a-fA-F]+)$/, "Restored $1"],
  [/^已把索引 (\d+) 替换为 (.+)（可撤销）$/, "Replaced index $1 with $2 (undoable)"],
  [/^索引 (\d+) 已是 (.+)$/, "Index $1 is already $2"],
  [/^已拷贝 (.+)$/, "Copied $1"],
  [/^(.+)：未找到支持的图片$/, (m) => `${translateText(m[1]) ?? m[1]}: no supported images found`],
  [/^(正在提取线稿|正在导入) (\d+)\/(\d+) · (.+)$/, (m) =>
    `${m[1] === "正在提取线稿" ? "Extracting line art" : "Importing"} ${m[2]}/${m[3]} · ${m[4]}`],
  [/^(线稿提取完成|导入完成) (\d+)\/(\d+) 张(.*)$/, (m) =>
    `${m[1] === "线稿提取完成" ? "Line art extracted" : "Import complete"} ${m[2]}/${m[3]}${tail(m[4])}`],
  [/^已重命名为「(.+)」$/, "Renamed to “$1”"],
  [/^色板可辨性：(\d+) 组低于 ([\d.]+) · 最小 ΔE ([\d.]+)（(.+) ↔ (.+)）$/, "Palette contrast: $1 pair(s) below $2 · min ΔE $3 ($4 ↔ $5)"],
  [/^色板可辨性：通过 · 最小 ΔE ([\d.]+)$/, "Palette contrast: pass · min ΔE $1"],
  [/^已取消批量导入 · 完成 (\d+)\/(\d+) 张$/, "Batch import cancelled · $1/$2 done"],
  [/^(\d+) 个线稿文档需选「线稿（引擎提取）」内容$/, "$1 line-art documents need the “Line art (engine)” export option"],
  [/^(\d+) 个无(墨线|源)文档$/, (m) => `${m[1]} document(s) without ${m[2] === "墨线" ? "ink" : "source image"}`],
  [/^· 跳过 (\d+) 个无(墨线|源)文档$/, (m) => `· skipped ${m[1]} document(s) without ${m[2] === "墨线" ? "ink" : "source image"}`],
  [/^· 跳过 (.+)$/, "· skipped $1"],
  [/^已导出 (\d+) 张图集（合并 (\d+) 个文档，按尺寸分组）(.*)$/, (m) => `Exported ${m[1]} sheets (merged ${m[2]} documents, grouped by size)${tail(m[3])}`],
  [/^已导出 (\d+) 个像素墨线层（PNG (\d+)%）(.*)$/, (m) => `Exported ${m[1]} pixel ink layers (PNG ${m[2]}%)${tail(m[3])}`],
  [/^已导出 (\d+) 个引擎线稿（原始分辨率）(.*)$/, (m) => `Exported ${m[1]} engine line-art images (source resolution)${tail(m[2])}`],
  [/^已导出 (\d+) 个文件（([A-Z]+) (\d+)% · 透明）(.*)$/, (m) => `Exported ${m[1]} files (${m[2]} ${m[3]}%, transparent)${tail(m[4])}`],
  [/^已导出 (\d+) 个文件（([A-Z]+) (\d+)%）(.*)$/, (m) => `Exported ${m[1]} files (${m[2]} ${m[3]}%)${tail(m[4])}`],
  [/^已导出 (\d+) 个索引 PNG(.*)$/, (m) => `Exported ${m[1]} indexed PNG files${tail(m[2])}`],
  [/^已导出 (\d+) 色 → (.+)\.gpl$/, "Exported $1 colors → $2.gpl"],
  [/^已导出 (\d+) 色 → (.+)\.hex$/, "Exported $1 colors → $2.hex"],
  [/^已导出配方 → (.+)$/, "Recipe exported → $1"],
  [/^未导出任何图集(.*)$/, (m) => `No sheets exported${tail(m[1])}`],
  [/^未导出任何文件(.*)$/, (m) => `No files exported${tail(m[1])}`],
  [/^未导出任何线稿 · 跳过 (\d+) 个无源图文档$/, "No line art exported · skipped $1 documents without a source image"],
  [/^索引 PNG 失败：(.*)$/, "Indexed PNG failed: $1"],
  [/^索引 PNG：(\d+)×(\d+) · (\d+) 色 · 含透明$/, "Indexed PNG: $1×$2 · $3 colors · transparent"],
  [/^索引 PNG：(\d+)×(\d+) · (\d+) 色$/, "Indexed PNG: $1×$2 · $3 colors"],
  [/^· 失败 (\d+)（(.*)）$/, "· $1 failed ($2)"],
  [/^· \+(\d+) 色$/, "· +$1 colors"],
  // 形如“· 本地 MCP”的 Agent 名称后缀：只翻名称本身，保留分隔符。
  [/^· (.+)$/, (m) => `· ${translateText(m[1]) ?? m[1]}`],
  [/^正在转换 (.+) → (\d+)×(\d+)$/, "Converting $1 → $2×$3"],
  [/^转换中… (.+)$/, "Converting… $1"],
  [/^重转换失败 (.+): (.*)$/, "Reconvert failed for $1: $2"],
  [/^提取线稿… (.+)$/, "Extracting line art… $1"],
  [/^正在提取线稿 (.+)$/, "Extracting line art: $1"],
  [/^线稿提取失败 (.+): (.*)$/, "Line-art extraction failed for $1: $2"],
  [/^细节重算中… (.+)（(\d+) 格）$/, "Recomputing details… $1 ($2 cells)"],
  [/^细节重算完成 · (\d+) 格 · 改动 (\d+) · ([\d.]+)ms$/, "Details recomputed · $1 cells · $2 changed · $3 ms"],
  [/^细节重算失败: (.*)$/, "Detail recompute failed: $1"],
  [/^已标记 (\d+) 格$/, "Marked $1 cells"],
  [/^第 (\d+) \/ (\d+) 步$/, "Step $1 of $2"],
  [/^已标记 (\d+) 格（Alt 擦除）；重算只写回标记格，可撤销。$/, "Marked $1 cells (Alt erases); recompute writes only marked cells, undoable."],
  [/^按色抠除 (\d+) 格$/, "Removed $1 cells by color"],
  [/^引擎 (.+) · 模型 (\d+)\/3 · (CUDA|DirectML|CPU)$/, "Engine $1 · models $2/3 · $3"],
  [/^引擎 (.+) · 模型 (\d+)\/3$/, "Engine $1 · models $2/3"],
  [/^引擎 (.+): (.*)$/, "Engine $1: $2"],
  [/^线稿 ([✓✗])$/, "Line art $1"],
  [/^Agent 更新 (.+) · (.+)$/, "Agent updated $1 · $2"],
  [/^Agent 更新尺寸不匹配（(\d+)×(\d+)），已忽略$/, "Agent update size mismatch ($1×$2) — ignored"],
  [/^MCP：(\d+) 个 Agent 在线$/, "MCP: $1 agents online"],
  [/^已接入 (\d+) 个 Agent。$/, "$1 agents connected."],
  [/^已接入 (\d+) 个 Agent · (\d+) 个正在控制。$/, "$1 agents connected · $2 controlling."],
  [/^已接入 (\d+) 个 Agent(.*)$/, "$1 agents connected$2"],
  [/^已应用配方到 (\d+) 个文档$/, "Recipe applied to $1 documents"],
  [/^已把「(.+)」的配方应用到 (\d+) 个文档$/, "Applied “$1” recipe to $2 documents"],
  [/^正在把「(.+)」的配方应用到 (\d+) 个文档…$/, "Applying “$1” recipe to $2 documents…"],
  [/^已导入配方（(.+)），正在重转换…$/, "Recipe imported ($1), reconverting…"],
  [/^配方已导入并重转换 (.+)$/, "Recipe imported; reconverted $1"],
  [/^已关闭其他 (\d+) 个标签$/, "Closed $1 other tabs"],
  [/^已关闭右侧 (\d+) 个标签$/, "Closed $1 tabs to the right"],
  [/^已保存项目 (.+)$/, "Project saved: $1"],
  [/^已打开项目 (.+) · (.+)$/, "Opened project $1 · $2"],
  [/^已重新绑定源图 (.+) · 可重新转换$/, "Source rebound: $1 · ready to reconvert"],
  [/^打开项目失败: (.*)$/, "Failed to open project: $1"],
  [/^保存失败: (.*)$/, "Save failed: $1"],
  [/^读取源图失败: (.*)$/, "Failed to read source image: $1"],
  [/^请选择项目文件「(.+)」$/, "Please choose the project file “$1”"],
  [/^未处理异常: (.*)$/, "Unhandled error: $1"],
  [/^界面异常: (.*)$/, "UI error: $1"],
  [/^关闭 (.+)$/, "Close $1"],
  [/^切换 (.+) 可见性$/, "Toggle visibility of $1"],
  [/^发现 (\d+) 个文档（自动保存于 (.+)）。$/, "Found $1 documents (autosaved at $2)."],
  [/^导入失败：(.*)$/, "Import failed: $1"],
  [/^未命名-(\d+)$/, "Untitled-$1"],
  [/^demo 失败: (.*)$/, "Demo failed: $1"],
  [/^(直线|矩形|椭圆)\(填充\)$/, (m) =>
    `${m[1] === "直线" ? "Line" : m[1] === "矩形" ? "Rectangle" : "Ellipse"} (filled)`],
  [/^(直线|矩形|椭圆)$/, (m) => (m[1] === "直线" ? "Line" : m[1] === "矩形" ? "Rectangle" : "Ellipse")],
];

interface TextPair {
  en: string;
  zh: string;
}

const textOrigins = new WeakMap<Text, TextPair>();
const attrOrigins = new WeakMap<Element, Map<string, TextPair>>();

let locale: Locale = "zh-CN";
let observer: MutationObserver | null = null;
const listeners = new Set<(loc: Locale) => void>();

/** 语言切换后的回调（用于重渲染“由数据派生”的文本，如 Agent 头像首字母）。 */
export function onLocaleChange(cb: (loc: Locale) => void): void {
  listeners.add(cb);
}

export function getLocale(): Locale {
  return locale;
}

/** 精确翻译一段文案（不做 DOM 操作）；未命中词条时原样返回。 */
export function t(zh: string): string {
  if (locale !== "en-US" || !HAN.test(zh)) return zh;
  return translateText(zh) ?? zh;
}

function translateText(core: string): string | null {
  const hit = EN[core];
  if (hit && hit !== core) return hit;
  for (const [re, rep] of DYN) {
    const m = core.match(re);
    if (!m) continue;
    return typeof rep === "string" ? core.replace(re, rep) : rep(m);
  }
  return null;
}

function rewriteRaw(raw: string): string | null {
  const core = raw.trim();
  if (!core || !HAN.test(core)) return null;
  const hit = translateText(core);
  if (!hit || hit === core) return null;
  const at = raw.indexOf(core);
  return at < 0 ? null : raw.slice(0, at) + hit + raw.slice(at + core.length);
}

/** 句尾片段（如“· 失败 2（a、b）”）也按同一套规则翻译，保留前导空白。 */
function tail(raw: string): string {
  return rewriteRaw(raw) ?? raw;
}

function localizeTextNode(node: Text): void {
  const raw = node.nodeValue ?? "";
  const next = rewriteRaw(raw);
  if (next === null) return;
  textOrigins.set(node, { en: next, zh: raw });
  node.nodeValue = next;
}

function localizeAttrs(el: Element): void {
  for (const name of ATTRS) {
    const raw = el.getAttribute(name);
    if (!raw) continue;
    const next = rewriteRaw(raw);
    if (next === null) continue;
    let map = attrOrigins.get(el);
    if (!map) attrOrigins.set(el, (map = new Map()));
    map.set(name, { en: next, zh: raw });
    el.setAttribute(name, next);
  }
}

function walk(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    localizeTextNode(node as Text);
    return;
  }
  if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    for (const child of Array.from(node.childNodes)) walk(child);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (SKIP_TAGS.has(el.tagName) || el.hasAttribute("data-i18n-skip")) return;
  localizeAttrs(el);
  for (const child of Array.from(el.childNodes)) walk(child);
}

/** 切回中文：只还原“当前值仍是当年写进去的英文”的节点，避免覆盖运行期新内容。 */
function restore(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const el = node as Text;
    const pair = textOrigins.get(el);
    if (pair && el.nodeValue === pair.en) el.nodeValue = pair.zh;
    return;
  }
  if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    for (const child of Array.from(node.childNodes)) restore(child);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const root = node as Element;
  const attrs = attrOrigins.get(root);
  if (attrs) {
    for (const [name, pair] of attrs) {
      if (root.getAttribute(name) === pair.en) root.setAttribute(name, pair.zh);
    }
  }
  if (SKIP_TAGS.has(root.tagName)) return;
  for (const child of Array.from(root.childNodes)) restore(child);
}

function onMutations(records: MutationRecord[]): void {
  if (locale !== "en-US") return;
  for (const record of records) {
    if (record.type === "characterData") {
      if (record.target.nodeType === Node.TEXT_NODE) localizeTextNode(record.target as Text);
    } else if (record.type === "attributes") {
      if (record.target instanceof Element) localizeAttrs(record.target);
    } else {
      for (const added of Array.from(record.addedNodes)) walk(added);
    }
  }
}

function startObserver(): void {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(onMutations);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
}

/** 切换语言并立即应用到整个文档。 */
export function setLocale(next: Locale): void {
  if (next === locale) {
    document.documentElement.lang = next;
    return;
  }
  // 先停观察：还原中文时若观察器还在，会被当成“新出现的中文”又翻回英文。
  stopObserver();
  if (next === "zh-CN") restore(document);
  locale = next;
  document.documentElement.lang = next;
  if (next === "en-US") {
    walk(document);
    startObserver();
  }
  for (const cb of listeners) cb(next);
}
