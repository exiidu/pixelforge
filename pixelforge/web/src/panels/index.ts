/** 标签栏面板（多文档切换/关闭；M5-6 拖拽重排 + 右键菜单）。 */

import { closeDoc, closeDocsToRight, closeOtherDocs, getState, moveDoc, setActive, setState,
  subscribe, activeDoc, layerFillAt, layerAlphaAt,
  type Tool, type Symmetry, type PaletteSort } from "../store";
import { jumpHistory } from "../tools";
import { ICONS } from "../icons";
import { rgb2hsl, gammaLum, hsv2rgb, hexToRgb, rgbToHex } from "../color";
import { confirmDiscard, confirmDialog } from "../dialogs";
import { getLocale, t } from "../i18n";

/** 关闭标签：有未保存手改时先确认（0.3.0）。 */
async function closeTabWithConfirm(index: number): Promise<void> {
  const doc = getState().docs[index];
  if (!doc) return;
  if (doc.dirty && !(await confirmDiscard([doc.name]))) return;
  closeDoc(index);
}

async function closeOthersWithConfirm(index: number): Promise<void> {
  const { docs } = getState();
  if (index < 0 || index >= docs.length || docs.length <= 1) {
    document.dispatchEvent(new CustomEvent("pf:status", { detail: "没有可关闭的其他标签" }));
    return;
  }
  const dirty = docs.filter((d, i) => i !== index && d.dirty).map((d) => d.name);
  if (dirty.length && !(await confirmDiscard(dirty))) return;
  const n = closeOtherDocs(index);
  document.dispatchEvent(new CustomEvent("pf:status", { detail: n ? `已关闭其他 ${n} 个标签` : "没有可关闭的其他标签" }));
}

async function closeRightWithConfirm(index: number): Promise<void> {
  const { docs } = getState();
  if (index < 0 || index >= docs.length - 1) {
    document.dispatchEvent(new CustomEvent("pf:status", { detail: "右侧没有标签" }));
    return;
  }
  const dirty = docs.slice(index + 1).filter((d) => d.dirty).map((d) => d.name);
  if (dirty.length && !(await confirmDiscard(dirty))) return;
  const n = closeDocsToRight(index);
  document.dispatchEvent(new CustomEvent("pf:status", { detail: n ? `已关闭右侧 ${n} 个标签` : "右侧没有标签" }));
}

/** 标签右键菜单（M5-6）：复制配方到全部 / 导出此文档 / 关闭其他 / 关闭右侧。 */
function showTabMenu(x: number, y: number, index: number): void {
  document.getElementById("tab-ctx")?.remove();
  const menu = document.createElement("div");
  menu.id = "tab-ctx";
  menu.className = "pf-ctx";
  menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 150)}px`;
  const items: Array<[string, () => void]> = [
    ["复制配方到全部标签", () => document.dispatchEvent(new CustomEvent("pf:recipes-to-all", { detail: index }))],
    ["导出此文档…", () => document.dispatchEvent(new CustomEvent("pf:export-doc", { detail: index }))],
    ["关闭其他标签", () => void closeOthersWithConfirm(index)],
    ["关闭右侧标签", () => void closeRightWithConfirm(index)],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => { fn(); menu.remove(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const close = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) { menu.remove(); window.removeEventListener("pointerdown", close); }
  };
  window.addEventListener("pointerdown", close);
  window.addEventListener("blur", () => menu.remove(), { once: true });
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    menu.remove();
    window.removeEventListener("pointerdown", close);
  });
  menu.querySelector<HTMLButtonElement>("button")?.focus();
}

export function mountTabs(container: HTMLElement): void {
  let dragFrom: number | null = null;
  let dragIndex: number | null = null;

  const redraw = () => {
    const { docs, activeIndex } = getState();
    container.textContent = "";
    if (docs.length === 0) {
      const e = document.createElement("span");
      e.className = "pf-tabs-empty";
      e.textContent = "没有打开的文档";
      container.appendChild(e);
      return;
    }
    docs.forEach((doc, i) => {
      const tab = document.createElement("div");
      tab.className = "pf-tab" + (i === activeIndex ? " active" : "") + (doc.dirty ? " dirty" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", i === activeIndex ? "true" : "false");
      tab.tabIndex = i === activeIndex ? 0 : -1;
      tab.draggable = true;
      tab.dataset.index = String(i);

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.title = "有未导出的手改";
      const label = document.createElement("span");
      label.textContent = doc.name;
      const close = document.createElement("button");
      close.className = "close";
      close.textContent = "×";
      close.setAttribute("aria-label", `关闭 ${doc.name}`);
      close.tabIndex = i === activeIndex ? 0 : -1;
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        void closeTabWithConfirm(i);
      });
      tab.append(dot, label, close);
      tab.addEventListener("click", () => setActive(i));
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) void closeTabWithConfirm(i); // 中键关闭
      });
      // 0.5.0：方向键在标签间移动焦点（roving tabindex），Enter/Space 激活
      tab.addEventListener("keydown", (e) => {
        if (e.target !== tab) return;
        const n = docs.length;
        let to = -1;
        if (e.key === "ArrowRight") to = (i + 1) % n;
        else if (e.key === "ArrowLeft") to = (i - 1 + n) % n;
        else if (e.key === "Home") to = 0;
        else if (e.key === "End") to = n - 1;
        if (to >= 0) {
          e.preventDefault();
          setActive(to);
          requestAnimationFrame(() => {
            container.querySelector<HTMLElement>(`.pf-tab[data-index="${to}"]`)?.focus();
          });
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setActive(i);
          requestAnimationFrame(() => {
            container.querySelector<HTMLElement>(`.pf-tab[data-index="${i}"]`)?.focus();
          });
        } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const rect = tab.getBoundingClientRect();
          showTabMenu(rect.left, rect.bottom, i);
        }
      });
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showTabMenu(e.clientX, e.clientY, i);
      });
      // M5-6 拖拽重排
      tab.addEventListener("dragstart", (e) => {
        dragFrom = i;
        tab.classList.add("dragging");
        e.dataTransfer?.setData("text/plain", String(i));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      tab.addEventListener("dragend", () => {
        dragFrom = null;
        dragIndex = null;
        container.querySelectorAll(".pf-tab").forEach((t) => t.classList.remove("dragging", "drop-before", "drop-after"));
      });
      tab.addEventListener("dragover", (e) => {
        if (dragFrom === null || dragFrom === i) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = tab.getBoundingClientRect();
        const after = e.clientX > rect.left + rect.width / 2;
        dragIndex = after ? i + 1 : i;
        container.querySelectorAll(".pf-tab").forEach((t) => t.classList.remove("drop-before", "drop-after"));
        tab.classList.add(after ? "drop-after" : "drop-before");
      });
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragFrom === null || dragIndex === null) return;
        const to = dragIndex > dragFrom ? dragIndex - 1 : dragIndex;
        moveDoc(dragFrom, Math.max(0, Math.min(docs.length - 1, to)));
        dragFrom = null;
        dragIndex = null;
      });
      container.appendChild(tab);
    });
  };
  subscribe(redraw);
  redraw();
}

/** 图层面板（M2.7：真实逻辑图层栈）。顶层在上；基础层（画布/文件）不可删。 */
export function mountLayers(container: HTMLElement): void {
  const redraw = () => {
    const doc = activeDoc();
    const sel = getState().selection;
    const active = document.activeElement as HTMLElement | null;
    const focusedLayer = active && container.contains(active) ? active.dataset.layerId : undefined;
    container.textContent = "";
    if (!doc) return;

    const head = document.createElement("div");
    head.className = "pf-layers-head";
    const title = document.createElement("span");
    title.textContent = `图层 ${doc.layers.length}${sel ? "" : ""}`;
    head.appendChild(title);
    if (sel) {
      for (const [mode, label] of [["cut", "剪切到新图层"], ["copy", "复制到新图层"]] as const) {
        const b = document.createElement("button");
        b.className = "pf-btn mini";
        b.textContent = label;
        b.title = "把选区内容提取为独立图层（剪切=原位清空）";
        b.addEventListener("click", () => {
          container.dispatchEvent(new CustomEvent("pf:extract-layer", { bubbles: true, detail: mode }));
        });
        head.appendChild(b);
      }
    }
    container.appendChild(head);

    // 渲染顺序：数组 index0 = 最底 → 列表顶层在上（倒序）
    for (let k = doc.layers.length - 1; k >= 0; k--) {
      const l = doc.layers[k];
      const isBase = l.id === doc.baseLayerId;
      const row = document.createElement("div");
      row.className =
        "pf-layer" + (l.id === doc.activeLayerId ? " active" : "") + (l.visible ? "" : " hidden");
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.dataset.layerId = l.id;
      row.setAttribute("aria-pressed", String(l.id === doc.activeLayerId));
      row.title = isBase
        ? `${l.name}（基础层：含引擎转换内容，不可删除）`
        : l.bg
          ? `${l.name}（自动拆分：透明格补边缘主色，默认隐藏=真透明；可显隐/删除）`
          : `${l.name} 点击激活`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = isBase ? "#7fbf5f" : l.bg ? "#b08bd8" : "#3a6ea5";
      const label = document.createElement("span");
      label.textContent = l.name;
      row.append(dot, label);

      // 文件层（基础层）带墨线叠加开关「线」
      if (isBase) {
        const tag = document.createElement("button");
        tag.className = "pf-ly-tag" + (doc.inkVisible ? "" : " off");
        tag.textContent = "线";
        tag.title = "墨线叠加开关（导出线稿不受此影响）";
        tag.addEventListener("click", (e) => {
          e.stopPropagation();
          doc.inkVisible = !doc.inkVisible;
          container.dispatchEvent(new CustomEvent("doc-changed", { bubbles: true }));
        });
        row.appendChild(tag);
      }

      const eye = document.createElement("button");
      eye.className = "eye";
      eye.textContent = l.visible ? "👁" : "🚫";
      eye.setAttribute("aria-label", `切换 ${l.name} 可见性`);
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        l.visible = !l.visible;
        container.dispatchEvent(new CustomEvent("doc-changed", { bubbles: true }));
      });
      row.appendChild(eye);

      if (!isBase) {
        const del = document.createElement("button");
        del.className = "pf-ly-del";
        del.textContent = "×";
        del.title = "删除图层（可撤销）";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          const en = getLocale() === "en-US";
          void confirmDialog({
            title: t("删除图层"),
            message: en
              ? `Delete layer “${l.name}”? This can be undone.`
              : `删除图层「${l.name}」？此操作可撤销。`,
            okText: t("删除"),
            cancelText: t("取消"),
          }).then((ok) => {
            if (ok) {
              container.dispatchEvent(new CustomEvent("pf:delete-layer", { bubbles: true, detail: l.id }));
            }
          });
        });
        row.appendChild(del);
      }

      row.addEventListener("click", () => {
        if (l.id === doc.activeLayerId) return;
        container.dispatchEvent(new CustomEvent("pf:set-active-layer", { bubbles: true, detail: l.id }));
      });
      row.addEventListener("keydown", (e) => {
        if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        if (l.id === doc.activeLayerId) return;
        container.dispatchEvent(new CustomEvent("pf:set-active-layer", { bubbles: true, detail: l.id }));
      });
      container.appendChild(row);
    }
    if (focusedLayer) {
      container.querySelector<HTMLElement>(`[data-layer-id="${focusedLayer}"]`)?.focus();
    }
  };
  subscribe(redraw);
  redraw();
}

/** 轻量「已删除 · 撤销」浮条（M5.2/B2）：色架是全局跨文档状态，不接入文档历史栈。 */
let toastTimer = 0;
function showUndoToast(text: string, onUndo: () => void): void {
  let el = document.getElementById("pf-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "pf-toast";
    el.className = "pf-toast";
    document.body.appendChild(el);
  }
  el.textContent = "";
  const span = document.createElement("span");
  span.textContent = text;
  const btn = document.createElement("button");
  btn.className = "pf-btn mini";
  btn.textContent = "撤销";
  const box = el;
  btn.addEventListener("click", () => { onUndo(); box.remove(); });
  el.append(span, btn);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box.remove(), 5000);
}

/** 调色板面板：文档颜色（上）+ 自定义色架（下，左键选用/右键删除），排序下拉对两组生效。 */
export function mountPalette(
  container: HTMLElement, countEl: HTMLElement | null,
  customEl: HTMLElement | null, sortSel: HTMLSelectElement | null,
): void {
  if (sortSel) {
    sortSel.value = getState().paletteSort;
    sortSel.addEventListener("change", () =>
      setState({ paletteSort: sortSel.value as PaletteSort }));
  }

  const sortKey = (c: [number, number, number], count: number, mode: PaletteSort): number[] => {
    const [h, s, l] = rgb2hsl(c);
    const gray = s < 0.08;
    switch (mode) {
      case "hue": return [gray ? 2 : 1, gray ? Math.round(l * 100) : Math.round(h)];
      case "light": return [-gammaLum(c)];
      case "sat": return [gray ? 2 : 1, -Math.round(s * 1000), Math.round(h)];
      default: return [-count];
    }
  };

  const hexOfRgb = (rgb: [number, number, number]) => rgbToHex(rgb);

  const sortCustom = (hexes: string[], mode: PaletteSort): string[] =>
    hexes.map((hex) => ({ hex, rgb: hexToRgb(hex)! }))
      .filter((x) => x.rgb)
      .sort((a, b) => {
        const ka = sortKey(a.rgb, 0, mode), kb = sortKey(b.rgb, 0, mode);
        return ka[0] - kb[0] || (ka[1] ?? 0) - (kb[1] ?? 0);
      })
      .map((x) => x.hex);

  /* ---- 自定义色架：左键选用（M2.7 已移除拖动排序） / 右键删除 ---- */

  const showCtxMenu = (hex: string, x: number, y: number) => {
    const menu = document.getElementById("pal-ctx");
    if (!menu) return;
    menu.dataset.hex = hex;
    menu.hidden = false;
    menu.style.left = `${Math.min(x, window.innerWidth - 120)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 44)}px`;
  };
  const hideCtxMenu = () => {
    const menu = document.getElementById("pal-ctx");
    if (menu) menu.hidden = true;
  };
  document.getElementById("pal-ctx-del")?.addEventListener("click", () => {
    const menu = document.getElementById("pal-ctx");
    const hex = menu?.dataset.hex;
    hideCtxMenu();
    if (!hex) return;
    const before = getState().customColors;
    const at = before.indexOf(hex);
    if (at < 0) return;
    setState({ customColors: before.filter((c) => c !== hex) });
    showUndoToast(`已删除色架颜色 ${hex}`, () => {
      const now = getState().customColors;
      if (now.includes(hex)) return;
      const next = [...now];
      next.splice(Math.min(at, next.length), 0, hex); // 恢复原位
      setState({ customColors: next });
      document.dispatchEvent(new CustomEvent("pf:status", { detail: `已恢复 ${hex}` }));
    });
  });
  window.addEventListener("pointerdown", (e) => {
    const menu = document.getElementById("pal-ctx");
    if (menu && !menu.hidden && !menu.contains(e.target as Node)) hideCtxMenu();
  });
  customEl?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const sw = (e.target as HTMLElement).closest?.("[data-hex]") as HTMLElement | null;
    if (sw?.dataset.hex) showCtxMenu(sw.dataset.hex, e.clientX, e.clientY);
    else hideCtxMenu();
  });

  const mountCustom = () => {
    if (!customEl) return;
    const active = document.activeElement as HTMLElement | null;
    const focusedHex = active && customEl.contains(active) ? active.dataset.hex : undefined;
    const { customColors, paletteSort } = getState();
    customEl.textContent = "";
    const ordered = sortCustom(customColors, paletteSort);
    if (ordered.length === 0) {
      const hint = document.createElement("div");
      hint.className = "pf-pal-hint";
      hint.textContent = "在下方「颜色库」取色后，点「加入到调色板」出现在这里";
      customEl.appendChild(hint);
      return;
    }
    const doc = activeDoc();
    const curHex = doc ? hexOfRgb(doc.palette[getState().colorIndex] ?? [0, 0, 0]) : "";
    for (const hex of ordered) {
      const rgb = hexToRgb(hex)!;
      const sw = document.createElement("button");
      sw.type = "button";
      sw.dataset.hex = hex;
      sw.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      sw.title = `${hex} · 左键选用 · 右键删除`;
      sw.setAttribute("aria-label", sw.title);
      sw.setAttribute("aria-pressed", String(hex === curHex));
      if (hex === curHex) sw.classList.add("sel");
      sw.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("pf:custom-color", { detail: { rgb } }));
      });
      customEl.appendChild(sw);
    }
    if (focusedHex) {
      customEl.querySelector<HTMLElement>(`[data-hex="${focusedHex}"]`)?.focus();
    }
  };

  const redraw = () => {
    const doc = activeDoc();
    const { colorIndex, paletteSort } = getState();
    const active = document.activeElement as HTMLElement | null;
    const focusedIdx = active && container.contains(active) ? active.dataset.idx : undefined;

    mountCustom();
    hideCtxMenu();

    if (!doc) {
      if (countEl) countEl.textContent = "";
      container.textContent = "";
      return;
    }
    const counts = new Map<number, number>();
    // 跨可见图层合成计数（与画布所见一致：上层透明露出下层，透明格不计）
    for (let i = 0; i < doc.w * doc.h; i++) {
      let idx = -1;
      for (let k = doc.layers.length - 1; k >= 0; k--) {
        const l = doc.layers[k];
        if (!l.visible) continue;
        const f = layerFillAt(doc, l, i);
        if (f < 0) continue;
        if (layerAlphaAt(doc, l, i) <= 0) continue;
        idx = f; break;
      }
      if (idx < 0) continue;
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    const order = [...counts.entries()].sort((a, b) => {
      const ka = sortKey(doc.palette[a[0]] ?? [0, 0, 0], a[1], paletteSort);
      const kb = sortKey(doc.palette[b[0]] ?? [0, 0, 0], b[1], paletteSort);
      return ka[0] - kb[0] || (ka[1] ?? 0) - (kb[1] ?? 0) || b[1] - a[1];
    });
    if (countEl) countEl.textContent = `${order.length} 色`;
    container.textContent = "";
    const total = doc.fill.length;
    for (const [idx, n] of order) {
      const c = doc.palette[idx] ?? [255, 0, 255];
      const sw = document.createElement("button");
      sw.type = "button";
      sw.dataset.idx = String(idx);
      sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
      sw.title = `${hexOfRgb(c)} · ${((100 * n) / total).toFixed(1)}%`;
      sw.setAttribute("aria-label", sw.title);
      sw.setAttribute("aria-pressed", String(idx === colorIndex));
      if (idx === colorIndex) sw.classList.add("sel");
      sw.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("pf:pick-color", { detail: idx }));
      });
      container.appendChild(sw);
    }
    if (focusedIdx !== undefined) {
      container.querySelector<HTMLElement>(`[data-idx="${focusedIdx}"]`)?.focus();
    }
  };
  subscribe(redraw);
  redraw();
}

/** 颜色库（折叠面板）：RGB 滑块 / 灰度滑块 / 色轮 / 十六进制。取色→自定义色架+当前色。 */
export function mountColorLib(root: HTMLElement): void {
  const modeSel = root.querySelector<HTMLSelectElement>("#lib-mode")!;
  const secs = {
    rgb: root.querySelector<HTMLElement>("#lib-rgb")!,
    gray: root.querySelector<HTMLElement>("#lib-gray")!,
    cube: root.querySelector<HTMLElement>("#lib-cube")!,
    wheel: root.querySelector<HTMLElement>("#lib-wheel")!,
    hex: root.querySelector<HTMLElement>("#lib-hex")!,
  };
  const prevBox = root.querySelector<HTMLElement>("#lib-prev")!;
  const hexLab = root.querySelector<HTMLElement>("#lib-hexlab")!;
  const sliders = {
    r: root.querySelector<HTMLInputElement>("#lib-r")!,
    g: root.querySelector<HTMLInputElement>("#lib-g")!,
    b: root.querySelector<HTMLInputElement>("#lib-b")!,
    gray: root.querySelector<HTMLInputElement>("#lib-gv")!,
  };
  const ring = root.querySelector<HTMLCanvasElement>("#lib-ring")!;
  const svs = [root.querySelector<HTMLCanvasElement>("#lib-sv")!, root.querySelector<HTMLCanvasElement>("#lib-sv2")!];
  const huebar = root.querySelector<HTMLCanvasElement>("#lib-huebar")!;
  const svCurs = [root.querySelector<HTMLElement>("#lib-sv-cur")!, root.querySelector<HTMLElement>("#lib-sv2-cur")!];
  const hueCur = root.querySelector<HTMLElement>("#lib-huebar-cur")!;
  const hexin = root.querySelector<HTMLInputElement>("#lib-hexin")!;

  const lib = { rgb: [255, 0, 0] as [number, number, number], hue: 0, sat: 1, val: 1, gray: 128 };
  let mode = "rgb";

  const pick = (rgb: [number, number, number]) => {
    // 只设当前色（进文档调色板），不自动进自定义色架——入架需点「加入到调色板」
    document.dispatchEvent(new CustomEvent("pf:lib-pick", { detail: { rgb } }));
  };

  const updatePrev = (rgb: [number, number, number]) => {
    const hex = rgbToHex(rgb);
    prevBox.style.background = hex;
    hexLab.textContent = hex;
  };
  const curRgb = (): [number, number, number] =>
    mode === "gray" ? [lib.gray, lib.gray, lib.gray]
      // cube 与 wheel 共用 hue/sat/val 状态（M2.7 修复：缺失 cube 分支导致取色/预览不一致）
      : mode === "wheel" || mode === "cube" ? hsv2rgb(lib.hue, lib.sat, lib.val)
        : lib.rgb;

  const refresh = () => updatePrev(curRgb());

  const setMode = (m: string) => {
    mode = m;
    for (const [k, el] of Object.entries(secs)) el.hidden = k !== m;
    refresh();
  };
  modeSel.addEventListener("change", () => setMode(modeSel.value));
  setMode("rgb");

  // RGB 滑块：拖动只刷预览，松手才入库（避免拖拽产生几十个中间色）
  for (const ch of ["r", "g", "b"] as const) {
    sliders[ch].addEventListener("input", () => {
      lib.rgb = [Number(sliders.r.value), Number(sliders.g.value), Number(sliders.b.value)];
      refresh();
    });
    sliders[ch].addEventListener("change", () => pick(lib.rgb));
  }
  sliders.gray.addEventListener("input", () => {
    lib.gray = Number(sliders.gray.value);
    refresh();
  });
  sliders.gray.addEventListener("change", () => pick(curRgb()));

  // 色轮：色环（点击取色相）+ 饱和度/明度方区；色相立方体共用同一 SV 状态
  const ringCtx = ring.getContext("2d")!;
  const R = ring.width, cx0 = R / 2, cy0 = R / 2, rOut = R / 2 - 1, rIn = rOut - 13;
  const img = ringCtx.createImageData(R, R);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const dx = x - cx0, dy = y - cy0;
      const r = Math.hypot(dx, dy);
      const k = (y * R + x) * 4;
      if (r <= rOut && r >= rIn) {
        const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const [rr, gg, bb] = hsv2rgb(h, 1, 1);
        img.data[k] = rr; img.data[k + 1] = gg; img.data[k + 2] = bb; img.data[k + 3] = 255;
      }
    }
  }
  ringCtx.putImageData(img, 0, 0);

  /** SV 方区（白→色相 × 黑）+ 圆环指示器；wheel 与 cube 两个画布同步。 */
  const drawSV = () => {
    for (const sv of svs) {
      const W = sv.width, H = sv.height;
      const ctx = sv.getContext("2d")!;
      const g1 = ctx.createLinearGradient(0, 0, W, 0);
      g1.addColorStop(0, "#ffffff");
      g1.addColorStop(1, `hsl(${lib.hue},100%,50%)`);
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, W, H);
      const g2 = ctx.createLinearGradient(0, 0, 0, H);
      g2.addColorStop(0, "rgba(0,0,0,0)");
      g2.addColorStop(1, "#000000");
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, W, H);
    }
    // 指示器（绝对定位圆环，跟随当前 S/V）
    svs.forEach((sv, k) => {
      const cur = svCurs[k];
      cur.style.left = `${lib.sat * sv.width - 6}px`;
      cur.style.top = `${(1 - lib.val) * sv.height - 6}px`;
      // 指示环颜色随明度反转，保证黑区/白区都可见
      cur.style.borderColor = lib.val > 0.6 ? "rgba(0,0,0,.85)" : "rgba(255,255,255,.95)";
    });
  };
  drawSV();

  /** 色相条（竖直彩虹渐变）+ 横向指示线。 */
  const drawHueBar = () => {
    const W = huebar.width, H = huebar.height;
    const ctx = huebar.getContext("2d")!;
    const imgB = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const [rr, gg, bb] = hsv2rgb((y / H) * 360, 1, 1);
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4;
        imgB.data[k] = rr; imgB.data[k + 1] = gg; imgB.data[k + 2] = bb; imgB.data[k + 3] = 255;
      }
    }
    ctx.putImageData(imgB, 0, 0);
    hueCur.style.top = `${(lib.hue / 360) * H - 2}px`;
  };
  drawHueBar();

  const setFromSV = (e: PointerEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    lib.sat = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    lib.val = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    drawSV();
    pick(curRgb());
    refresh();
  };
  const setFromHue = (e: PointerEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    lib.hue = Math.max(0, Math.min(0.999, (e.clientY - rect.top) / rect.height)) * 360;
    drawSV();
    drawHueBar();
    pick(curRgb());
    refresh();
  };
  // 合成事件的 pointerId 非活跃时 capture 会抛错——吞掉即可，真实指针不受影响
  const safeCapture = (el: Element, e: PointerEvent) => {
    try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
  };
  // 点击 + 按住拖动都取色
  for (const sv of svs) {
    sv.addEventListener("pointerdown", (e) => {
      safeCapture(sv, e);
      setFromSV(e, sv);
    });
    sv.addEventListener("pointermove", (e) => {
      if (e.buttons & 1) setFromSV(e, sv);
    });
  }
  huebar.addEventListener("pointerdown", (e) => {
    safeCapture(huebar, e);
    setFromHue(e, huebar);
  });
  huebar.addEventListener("pointermove", (e) => {
    if (e.buttons & 1) setFromHue(e, huebar);
  });
  ring.addEventListener("pointerdown", (e) => {
    safeCapture(ring, e);
    const rect = ring.getBoundingClientRect();
    const dx = e.clientX - rect.left - cx0, dy = e.clientY - rect.top - cy0;
    lib.hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    drawSV();
    pick(curRgb());
    refresh();
  });

  const applyHex = () => {
    const rgb = hexToRgb(hexin.value);
    if (rgb) pick(rgb);
    hexin.value = "";
  };
  root.querySelector("#lib-hexok")?.addEventListener("click", applyHex);
  hexin.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyHex();
  });

  root.querySelector("#lib-add")?.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("pf:custom-color", { detail: { rgb: curRgb() } }));
  });
  root.querySelector("#lib-replace")?.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("pf:replace-color", { detail: { rgb: curRgb() } }));
  });
  root.querySelector("#lib-copy")?.addEventListener("click", () => {
    const doc = activeDoc();
    const c = doc?.palette[getState().colorIndex] ?? curRgb();
    const hex = rgbToHex(c);
    void navigator.clipboard?.writeText(hex).catch(() => {});
    document.dispatchEvent(new CustomEvent("pf:status", { detail: `已拷贝 ${hex}` }));
  });
}

/** 编辑工具卡：图标注入 + 工具/笔刷/对称/撤销重做状态。选区跨工具持久（Esc/单击取消）。 */
export function mountTools(): void {
  const TOOLS: Array<[Tool, string, string]> = [
    ["move", "tool-move", "移动（V）· 拖拽移动选区/手改内容"],
    ["select", "tool-select", "矩形选区（S）· 拖拽框选，单击=取消；方向键移动、Shift+方向键复制、H·V 翻转"],
    ["lasso", "tool-lasso", "磁力套索（Q）· 沿色边吸附圈选元素"],
    ["pencil", "tool-pencil", "铅笔（B）· pixel-perfect"],
    ["eraser", "tool-eraser", "橡皮（E）· 删手改回算法值"],
    ["bucket", "tool-bucket", "油漆桶（G）· 泛洪同色连通区"],
    ["picker", "tool-picker", "取色（I）"],
    ["detail", "tool-detail", "细节（D）· 标记局部重算区域（Alt 擦除）"],
    ["alpha", "tool-alpha", "抠背景（W）· 拖拽刷透明、Alt 恢复、Shift+点按色抠除整片同色背景"],
    ["line", "tool-line", "直线（L）· 拖拽画线"],
    ["rect", "tool-rect", "矩形（R）· 拖拽画框，按住 Shift 填充"],
    ["ellipse", "tool-ellipse", "椭圆（O）· 拖拽画椭圆，按住 Shift 填充"],
    ["hand", "tool-hand", "手掌（H 或按住空格）· 拖拽平移画布视图"],
  ];
  for (const [, id, tip] of TOOLS) {
    const el = document.getElementById(id);
    if (el) {
      el.innerHTML = ICONS[id.replace("tool-", "")] ?? "";
      el.title = tip;
      el.setAttribute("aria-label", tip);
    }
  }
  for (const id of ["btn-undo", "btn-redo"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = ICONS[id === "btn-undo" ? "undo" : "redo"];
  }
  const syms: Array<[Symmetry, string]> = [
    ["off", "sym-off"], ["h", "sym-h"], ["v", "sym-v"], ["quad", "sym-quad"],
  ];
  const brushes = [1, 2, 3, 4];
  const redraw = () => {
    const { tool, symmetry, brushSize } = getState();
    for (const [t, id] of TOOLS) {
      const el = document.getElementById(id);
      el?.classList.toggle("active", tool === t);
      el?.setAttribute("aria-pressed", String(tool === t));
    }
    for (const [s, id] of syms) {
      const el = document.getElementById(id);
      el?.classList.toggle("active", symmetry === s);
      el?.setAttribute("aria-pressed", String(symmetry === s));
    }
    for (const b of brushes) {
      const el = document.getElementById(`brush-${b}`);
      el?.classList.toggle("active", brushSize === b);
      el?.setAttribute("aria-pressed", String(brushSize === b));
    }
    const doc = activeDoc();
    const u = document.getElementById("btn-undo") as HTMLButtonElement | null;
    const r = document.getElementById("btn-redo") as HTMLButtonElement | null;
    if (u) u.disabled = !doc || doc.history.undo.length === 0;
    if (r) r.disabled = !doc || doc.history.redo.length === 0;
  };
  for (const [t, id] of TOOLS)
    document.getElementById(id)?.addEventListener("click", () => setState({ tool: t }));
  for (const [s, id] of syms)
    document.getElementById(id)?.addEventListener("click", () => setState({ symmetry: s }));
  for (const b of brushes)
    document.getElementById(`brush-${b}`)?.addEventListener("click", () => setState({ brushSize: b }));
  document.getElementById("btn-undo")?.addEventListener("click", () =>
    document.dispatchEvent(new CustomEvent("pf:undo")));
  document.getElementById("btn-redo")?.addEventListener("click", () =>
    document.dispatchEvent(new CustomEvent("pf:redo")));
  subscribe(redraw);
  redraw();
}

/** 历史面板：undo 栈条目 + redo 展望（future 半透明），点击跳转。 */
export function mountHistory(container: HTMLElement): void {
  const redraw = () => {
    const doc = activeDoc();
    container.textContent = "";
    if (!doc) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "无文档";
      container.appendChild(e);
      return;
    }
    const { undo, redo } = doc.history;
    const mk = (label: string, cls: string, target: number) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = cls;
      b.addEventListener("click", () => {
        jumpHistory(doc, target);
        container.dispatchEvent(new CustomEvent("doc-changed", { bubbles: true }));
      });
      return b;
    };
    if (undo.length === 0 && redo.length === 0) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "尚无手改";
      container.appendChild(e);
      return;
    }
    undo.forEach((h, k) =>
      container.appendChild(mk(
        h.label + (h.steps.reduce((n, s) => n + s.ops.length, 0) > 1
          ? ` ·${h.steps.reduce((n, s) => n + s.ops.length, 0)}` : ""),
        k === undo.length - 1 ? "cur" : "", k + 1)));
    for (let k = redo.length - 1; k >= 0; k--)
      container.appendChild(mk(redo[k].label, "future", undo.length + redo.length - k));
  };
  subscribe(redraw);
  redraw();
}
