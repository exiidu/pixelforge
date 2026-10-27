/** 帮助中心（A2）：把主界面上常驻的指导文案集中到这里，按 F1 或状态栏「帮助」打开。
 *
 * 帮助正文直接以中英双语数据维护（不走 i18n 词表），切换语言时整体重渲染；
 * 这样长文档不会污染 i18n-dict，也不需要逐句维护 DOM 词条。
 */
import { getLocale, onLocaleChange } from "./i18n";

interface L {
  zh: string;
  en: string;
}

type Block =
  | { kind: "h"; text: L }
  | { kind: "p"; text: L }
  | { kind: "list"; items: L[] }
  | { kind: "keys"; rows: { key: string; text: L }[] };

interface Section {
  id: string;
  title: L;
  blocks: Block[];
}

const SECTIONS: Section[] = [
  {
    id: "start",
    title: { zh: "快速开始", en: "Quick start" },
    blocks: [
      { kind: "p", text: {
        zh: "首次启动会先选择界面语言；之后随时可在「设置 → 通用」里切换。",
        en: "On first launch you pick the interface language; you can change it anytime in Settings → General.",
      } },
      { kind: "p", text: {
        zh: "打开图片或整个文件夹开始转换；也可以「新建画布」进入空白像素编辑器。多选与文件夹都会自动批量处理。",
        en: "Open an image or a whole folder to start converting, or use “New canvas” for an empty pixel editor. Multi-select and folders are processed in batch.",
      } },
      { kind: "p", text: {
        zh: "选择预设与尺寸后，参数改动会自动重算当前文档；勾选「应用到全部标签」可一次改所有文档。",
        en: "Pick a preset and size; parameter changes automatically re-convert the current document. Check “Apply to all tabs” to update every document at once.",
      } },
      { kind: "p", text: {
        zh: "用编辑工具手改；手改保存在图层里，重转换后仍会保留。",
        en: "Use the editing tools for manual fixes; edits live in layers and survive re-conversion.",
      } },
      { kind: "p", text: {
        zh: "完成后打开「导出」，选择内容、格式与倍率。",
        en: "When done, open “Export” and choose content, format, and scale.",
      } },
    ],
  },
  {
    id: "canvas",
    title: { zh: "画布与视图", en: "Canvas & view" },
    blocks: [
      { kind: "p", text: {
        zh: "滚轮缩放画布；按住空格可临时切换手掌拖拽，Esc 取消选区。",
        en: "Scroll to zoom; hold Space for a temporary hand tool; Esc clears the selection.",
      } },
      { kind: "p", text: {
        zh: "按住状态栏「按住对比源图」查看原图；「描图」滑杆把源图垫在图层下方。",
        en: "Hold “Compare source” in the status bar to see the original; the “Trace” slider places the source beneath the layers.",
      } },
      { kind: "p", text: {
        zh: "状态栏可切换网格线；右侧面板依次是图层、历史与调色板。",
        en: "The status bar toggles grid lines; the right panel holds layers, history, and the palette.",
      } },
    ],
  },
  {
    id: "tools",
    title: { zh: "工具与快捷键", en: "Tools & shortcuts" },
    blocks: [
      { kind: "keys", rows: [
        { key: "V", text: { zh: "移动", en: "Move" } },
        { key: "S", text: { zh: "矩形选区", en: "Rectangular selection" } },
        { key: "Q", text: { zh: "磁力套索", en: "Magnetic lasso" } },
        { key: "B", text: { zh: "铅笔", en: "Pencil" } },
        { key: "E", text: { zh: "橡皮", en: "Eraser" } },
        { key: "G", text: { zh: "油漆桶", en: "Bucket" } },
        { key: "I", text: { zh: "取色", en: "Color picker" } },
        { key: "D", text: { zh: "细节", en: "Detail" } },
        { key: "W", text: { zh: "抠背景", en: "Remove background" } },
        { key: "L", text: { zh: "直线", en: "Line" } },
        { key: "R", text: { zh: "矩形", en: "Rectangle" } },
        { key: "O", text: { zh: "椭圆", en: "Ellipse" } },
        { key: "M", text: { zh: "对称循环", en: "Cycle symmetry" } },
        { key: "Ctrl+Z", text: { zh: "撤销", en: "Undo" } },
        { key: "Ctrl+Y", text: { zh: "重做", en: "Redo" } },
        { key: "Space", text: { zh: "临时手掌", en: "Temporary hand" } },
        { key: "Esc", text: { zh: "取消选区", en: "Clear selection" } },
      ] },
      { kind: "p", text: {
        zh: "笔刷支持 1–4 px；对称可循环切换关 / 左右 / 上下 / 四分。",
        en: "Brushes come in 1–4 px; symmetry cycles through Off / Horizontal / Vertical / Quad.",
      } },
      { kind: "p", text: {
        zh: "绘制只作用于活动图层；有选区时，绘制被限制在选区内。",
        en: "Drawing applies to the active layer only; when a selection exists, painting is confined to it.",
      } },
      { kind: "p", text: {
        zh: "导入透明素材会自动在下方建「背景层」（默认隐藏），可在图层面板显隐或删除。",
        en: "Importing transparent assets creates a hidden “Background layer” below; toggle or delete it in the Layers panel.",
      } },
    ],
  },
  {
    id: "layers",
    title: { zh: "图层与调色板", en: "Layers & palette" },
    blocks: [
      { kind: "p", text: {
        zh: "图层栈：画布层承载手改，文件层承载转换结果；移动与翻转只作用于活动层。",
        en: "Layer stack: canvas layers hold manual edits, file layers hold converter output; move and flip affect the active layer only.",
      } },
      { kind: "p", text: {
        zh: "调色板支持排序、单色编辑、锁定色板（重转换时保留），以及 .hex / .gpl 导入导出。",
        en: "The palette supports sorting, per-color editing, palette locking (kept across re-conversion), and .hex / .gpl import and export.",
      } },
      { kind: "p", text: {
        zh: "色板变换只改索引颜色、不动格子，可一键换季节或夜景。",
        en: "Palette transform changes indexed colors without moving cells — a one-click seasonal or night look.",
      } },
      { kind: "p", text: {
        zh: "索引 PNG 保留色板结构（PLTE），透明格写入 tRNS。",
        en: "Indexed PNG keeps the palette structure (PLTE) and writes tRNS for transparent cells.",
      } },
    ],
  },
  {
    id: "convert",
    title: { zh: "转换参数", en: "Conversion parameters" },
    blocks: [
      { kind: "p", text: {
        zh: "参数含义：边缘权重强调轮廓，暗部权重保留阴影，对比度调整整体反差。",
        en: "Parameters: edge weight emphasizes outlines, shadow weight preserves dark detail, contrast adjusts overall punch.",
      } },
      { kind: "p", text: {
        zh: "亮部对比只增强亮部（0 = 关闭）；软边比例与合并阈值控制色块边缘与合并；色数越少画面越概括。",
        en: "Highlight contrast boosts highlights only (0 = off); soft-edge ratio and merge threshold control block edges and merging; fewer colors give a more abstract result.",
      } },
      { kind: "p", text: {
        zh: "线稿可选关闭 / XDoG / ONNX（精细）；「引擎墨线」把引擎线稿叠加到画布上。",
        en: "Line art can be Off / XDoG / ONNX (fine); “Engine ink” overlays converter line art on the canvas.",
      } },
      { kind: "p", text: {
        zh: "滑杆改动会 300ms 防抖后重转换；空白画布不参与转换。",
        en: "Slider changes re-convert after a 300 ms debounce; blank canvases are not converted.",
      } },
      { kind: "p", text: {
        zh: "线稿预设生成源分辨率的只读线稿文档；切回照片/插画会重新转换并重置手改与图层。",
        en: "The line-art preset produces a read-only, source-resolution line-art document; switching back to Photo/Illustration re-converts and resets manual edits and layers.",
      } },
    ],
  },
  {
    id: "detail",
    title: { zh: "细节重算", en: "Detail recompute" },
    blocks: [
      { kind: "p", text: {
        zh: "选择「细节」笔刷（D）标记需要保留细节的区域，按住 Alt 擦除标记；强度分轻 / 中 / 强。",
        en: "Use the Detail brush (D) to mark areas that need extra detail; hold Alt to erase marks; strength is Light / Medium / Strong.",
      } },
      { kind: "p", text: {
        zh: "点「重算细节区」只写回标记格，可撤销；未标记则只做整幅重转换。",
        en: "“Recompute detail areas” writes back only marked cells and is undoable; without marks only a full re-conversion runs.",
      } },
      { kind: "p", text: {
        zh: "空白画布或无源图文档不支持；重转换后网格尺寸变化会使标记失效。",
        en: "Unavailable for blank canvases or documents without a source image; changing grid size after re-conversion invalidates marks.",
      } },
    ],
  },
  {
    id: "export",
    title: { zh: "导入与导出", en: "Import & export" },
    blocks: [
      { kind: "p", text: {
        zh: "勾选多个文档即可批量导出，每个文档一个文件；命名模板支持 {name}、{size}、{preset}。",
        en: "Check several documents to export in batch, one file each; naming templates support {name}, {size}, {preset}.",
      } },
      { kind: "p", text: {
        zh: "内容可选：像素画合成 / 索引 PNG / 线稿（引擎提取）/ 像素墨线层。",
        en: "Content options: pixel-art composite / indexed PNG / line art (engine-extracted) / pixel ink layer.",
      } },
      { kind: "p", text: {
        zh: "格式支持 PNG（含透明）、JPEG（白底）、WEBP；倍率用最近邻放大，不糊像素。",
        en: "Formats: PNG (with transparency), JPEG (white background), WEBP; scaling uses nearest-neighbor to keep pixels crisp.",
      } },
      { kind: "p", text: {
        zh: "精灵图集把同尺寸文档合并为水平条带，按尺寸分组，每组一个文件。",
        en: "Sprite atlas merges same-size documents into horizontal strips, grouped by size, one file per group.",
      } },
      { kind: "p", text: {
        zh: "索引 PNG 输出 PLTE 调色板（透明格写 tRNS），最多 256 色；引擎线稿按源图原始分辨率导出。",
        en: "Indexed PNG outputs a PLTE palette (tRNS for transparent cells), up to 256 colors; engine line art exports at the source resolution.",
      } },
    ],
  },
  {
    id: "mcp",
    title: { zh: "MCP 与 Agent", en: "MCP & Agent" },
    blocks: [
      { kind: "p", text: {
        zh: "引擎启动后，MCP 客户端会自动注册到「设置 → MCP / Agent」。",
        en: "Once the engine is running, MCP clients register automatically under Settings → MCP / Agent.",
      } },
      { kind: "p", text: {
        zh: "在那一页逐个允许 Agent 可用的功能；权限保存在本机并同步到引擎，工具调用时校验。",
        en: "Allow features per Agent there; permissions are stored locally and synced to the engine, checked on every tool call.",
      } },
      { kind: "p", text: {
        zh: "Agent 操作期间会显示控制蒙版并临时锁定编辑器；点「解除控制」可立即收回。",
        en: "While an Agent works, a control overlay appears and the editor is locked; click “Release control” to take it back.",
      } },
      { kind: "p", text: {
        zh: "Agent 修改文档时状态栏显示 Agent · 文档 · rev N，画面按 WebSocket 实时刷新，本地手改仍在最上层。",
        en: "When an Agent edits a document the status bar shows Agent · document · rev N; the canvas refreshes over WebSocket while local edits stay on top.",
      } },
    ],
  },
  {
    id: "faq",
    title: { zh: "常见问题", en: "FAQ" },
    blocks: [
      { kind: "list", items: [
        {
          zh: "「无源图（会话恢复的上传文件）」：源文件没有存到本机，重新导入源图后再转换。",
          en: "“No source image (file restored from session)”: the source was not stored locally; re-import it before converting.",
        },
        {
          zh: "空白画布不经过转换引擎，也不支持细节重算。",
          en: "Blank canvases skip the conversion engine and do not support detail recompute.",
        },
        {
          zh: "线稿文档是源分辨率只读视图，不做像素化；导出为清晰线稿 PNG。",
          en: "Line-art documents are read-only views at source resolution, not pixelated; export them as crisp line-art PNG.",
        },
        {
          zh: "会话恢复不包含撤销历史；自动保存每 30 秒运行一次。",
          en: "Session restore does not include undo history; autosave runs every 30 seconds.",
        },
        {
          zh: "转换或导出失败时先看状态栏提示；引擎健康状态在「设置 → 转换引擎」。",
          en: "If a conversion or export fails, check the status bar first; engine health is under Settings → Conversion engine.",
        },
      ] },
    ],
  },
];

let mounted = false;
let activeId = SECTIONS[0].id;

function text(value: L): string {
  return getLocale() === "en-US" ? value.en : value.zh;
}

function renderBlock(block: Block): HTMLElement {
  if (block.kind === "h") {
    const h = document.createElement("h4");
    h.textContent = text(block.text);
    return h;
  }
  if (block.kind === "p") {
    const p = document.createElement("p");
    p.textContent = text(block.text);
    return p;
  }
  if (block.kind === "list") {
    const ul = document.createElement("ul");
    for (const item of block.items) {
      const li = document.createElement("li");
      li.textContent = text(item);
      ul.append(li);
    }
    return ul;
  }
  const grid = document.createElement("div");
  grid.className = "pf-help-keys";
  for (const row of block.rows) {
    const kbd = document.createElement("kbd");
    kbd.textContent = row.key;
    const desc = document.createElement("span");
    desc.textContent = text(row.text);
    grid.append(kbd, desc);
  }
  return grid;
}

function showSection(id: string): void {
  if (!SECTIONS.some((s) => s.id === id)) return;
  activeId = id;
  for (const btn of document.querySelectorAll<HTMLElement>("#help-nav [data-help]")) {
    btn.classList.toggle("active", btn.dataset.help === id);
  }
  for (const pane of document.querySelectorAll<HTMLElement>("#help-panes [data-help-pane]")) {
    pane.hidden = pane.dataset.helpPane !== id;
  }
}

function render(): void {
  const nav = document.getElementById("help-nav");
  const panes = document.getElementById("help-panes");
  if (!nav || !panes) return;
  nav.textContent = "";
  panes.textContent = "";
  for (const section of SECTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.help = section.id;
    btn.textContent = text(section.title);
    btn.classList.toggle("active", section.id === activeId);
    btn.addEventListener("click", () => showSection(section.id));
    nav.append(btn);

    const pane = document.createElement("section");
    pane.className = "pf-help-sec";
    pane.dataset.helpPane = section.id;
    pane.hidden = section.id !== activeId;
    for (const block of section.blocks) pane.append(renderBlock(block));
    panes.append(pane);
  }
}

/** 打开帮助中心；可指定小节 id（如 start / tools / faq）。 */
export function openHelp(id?: string): void {
  const dlg = document.getElementById("helpdlg") as HTMLDialogElement | null;
  if (!dlg) return;
  if (id && SECTIONS.some((s) => s.id === id)) activeId = id;
  render();
  if (!dlg.open) dlg.showModal();
}

export function mountHelp(): void {
  if (mounted) return;
  mounted = true;

  document.getElementById("help-btn")?.addEventListener("click", () => openHelp());
  document.getElementById("empty-help")?.addEventListener("click", () => openHelp());
  const dlg = document.getElementById("helpdlg") as HTMLDialogElement | null;
  document.getElementById("help-close")?.addEventListener("click", () => dlg?.close());
  dlg?.addEventListener("click", (event) => {
    if (event.target === dlg) dlg.close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "F1") return;
    event.preventDefault();
    openHelp();
  });

  // 帮助正文由数据渲染，切换语言时整体重绘。
  onLocaleChange(() => render());
  render();
}
