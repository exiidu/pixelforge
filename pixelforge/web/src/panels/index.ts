/** 标签栏面板（多文档切换/关闭）。 */

import { closeDoc, getState, setActive, setState, subscribe, activeDoc, layerFillAt,
  type Tool, type Symmetry, type PaletteSort } from "../store";
import { jumpHistory } from "../tools";
import { ICONS } from "../icons";
import { rgb2hsl, gammaLum, hsv2rgb, hexToRgb, rgbToHex } from "../color";

export function mountTabs(container: HTMLElement): void {
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

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.title = "有未导出的手改";
      const label = document.createElement("span");
      label.textContent = doc.name;
      const close = document.createElement("button");
      close.className = "close";
      close.textContent = "×";
      close.setAttribute("aria-label", `关闭 ${doc.name}`);
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDoc(i);
      });
      tab.append(dot, label, close);
      tab.addEventListener("click", () => setActive(i));
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) closeDoc(i); // 中键关闭
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
      row.title = isBase
        ? `${l.name}（基础层：含引擎转换内容，不可删除）`
        : `${l.name} 点击激活`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = isBase ? "#7fbf5f" : "#3a6ea5";
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
          container.dispatchEvent(new CustomEvent("pf:delete-layer", { bubbles: true, detail: l.id }));
        });
        row.appendChild(del);
      }

      row.addEventListener("click", () => {
        if (l.id === doc.activeLayerId) return;
        container.dispatchEvent(new CustomEvent("pf:set-active-layer", { bubbles: true, detail: l.id }));
      });
      container.appendChild(row);
    }
  };
  subscribe(redraw);
  redraw();
}

/** 调色板面板：文档颜色（上）+ 自定义色架（下，左键拖动排序/右键删除），排序下拉对两组生效。 */
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
    if (hex) setState({ customColors: getState().customColors.filter((c) => c !== hex) });
    hideCtxMenu();
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
      const sw = document.createElement("div");
      sw.dataset.hex = hex;
      sw.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      sw.title = `${hex} · 左键选用 · 右键删除`;
      if (hex === curHex) sw.classList.add("sel");
      sw.addEventListener("pointerdown", (e) => {
        if (e.button === 0) {
          document.dispatchEvent(new CustomEvent("pf:custom-color", { detail: { rgb } }));
        }
      });
      customEl.appendChild(sw);
    }
  };

  const redraw = () => {
    const doc = activeDoc();
    const { colorIndex, paletteSort } = getState();

    mountCustom();
    hideCtxMenu();

    if (!doc) {
      if (countEl) countEl.textContent = "";
      container.textContent = "";
      return;
    }
    const counts = new Map<number, number>();
    // 跨可见图层合成计数（与画布所见一致）
    for (let i = 0; i < doc.w * doc.h; i++) {
      let idx = -1;
      for (let k = doc.layers.length - 1; k >= 0; k--) {
        const l = doc.layers[k];
        if (!l.visible) continue;
        const f = layerFillAt(doc, l, i);
        if (f >= 0) { idx = f; break; }
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
      const sw = document.createElement("div");
      sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
      sw.title = `${hexOfRgb(c)} · ${((100 * n) / total).toFixed(1)}%`;
      if (idx === colorIndex) sw.classList.add("sel");
      sw.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("pf:pick-color", { detail: idx }));
      });
      container.appendChild(sw);
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
    for (const [t, id] of TOOLS)
      document.getElementById(id)?.classList.toggle("active", tool === t);
    for (const [s, id] of syms)
      document.getElementById(id)?.classList.toggle("active", symmetry === s);
    for (const b of brushes)
      document.getElementById(`brush-${b}`)?.classList.toggle("active", brushSize === b);
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
