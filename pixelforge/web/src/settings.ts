/** 全局设置中心：持久化、主题/强调色、默认编辑器参数、MCP 管理入口。 */

import { setState } from "./store";
import { setLocale } from "./i18n";

declare const __APP_VERSION__: string;

export type ThemeMode = "system" | "light" | "dark";
export type AccentColor = "green" | "blue" | "amber";
export type DefaultPreset = "photo" | "illustration" | "lineart";

export interface AppSettings {
  version: number;
  language: "zh-CN" | "en-US";
  theme: ThemeMode;
  accent: AccentColor;
  reduceMotion: boolean;
  highContrast: boolean;
  defaultPreset: DefaultPreset;
  defaultSize: number;
  showGrid: boolean;
  agentNotifications: boolean;
}

const KEY = "pf.settings.v1";
const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  language: "zh-CN",
  theme: "system",
  accent: "green",
  reduceMotion: false,
  highContrast: false,
  defaultPreset: "photo",
  defaultSize: 64,
  showGrid: true,
  agentNotifications: true,
};

let current: AppSettings = loadSettings();
let mounted = false;
let userTab = "general";

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function clampSize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.defaultSize;
  return Math.max(16, Math.min(512, Math.round(n)));
}

function normalize(raw: unknown): AppSettings {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const theme = source.theme === "light" || source.theme === "dark" ? source.theme : "system";
  const accent = source.accent === "blue" || source.accent === "amber" ? source.accent : "green";
  const preset = source.defaultPreset === "illustration" || source.defaultPreset === "lineart"
    ? source.defaultPreset
    : "photo";
  return {
    version: 1,
    language: source.language === "en-US" ? "en-US" : "zh-CN",
    theme,
    accent,
    reduceMotion: source.reduceMotion === true,
    highContrast: source.highContrast === true,
    defaultPreset: preset,
    defaultSize: clampSize(source.defaultSize),
    showGrid: source.showGrid !== false,
    agentNotifications: source.agentNotifications !== false,
  };
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return normalize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* localStorage 不可用时仅内存生效 */
  }
}

function applyAppearance(): void {
  const root = document.documentElement;
  root.style.colorScheme = current.theme === "system" ? "" : current.theme;
  root.dataset.accent = current.accent;
  root.classList.toggle("pf-reduce-motion", current.reduceMotion);
  if (current.highContrast) root.dataset.contrast = "high";
  else delete root.dataset.contrast;
  setLocale(current.language);
}

function applyEditorDefaults(): void {
  setState({
    preset: current.defaultPreset,
    size: current.defaultSize,
    showGrid: current.showGrid,
  });
}

function applyAll(editorDefaults: boolean): void {
  applyAppearance();
  if (editorDefaults) applyEditorDefaults();
  persist();
  syncControls();
  document.dispatchEvent(new CustomEvent("pf:settings-changed", {
    detail: { settings: { ...current } },
  }));
}

function syncControls(): void {
  const lang = $<HTMLSelectElement>("set-language");
  if (lang) lang.value = current.language;
  const theme = $<HTMLSelectElement>("set-theme");
  if (theme) theme.value = current.theme;
  const preset = $<HTMLSelectElement>("set-default-preset");
  if (preset) preset.value = current.defaultPreset;
  const size = $<HTMLSelectElement>("set-default-size");
  if (size) size.value = String(current.defaultSize);
  const grid = $<HTMLInputElement>("set-show-grid");
  if (grid) grid.checked = current.showGrid;
  const motion = $<HTMLInputElement>("set-reduce-motion");
  if (motion) motion.checked = current.reduceMotion;
  const contrast = $<HTMLInputElement>("set-high-contrast");
  if (contrast) contrast.checked = current.highContrast;
  const notify = $<HTMLInputElement>("set-agent-notify");
  if (notify) notify.checked = current.agentNotifications;
  for (const btn of document.querySelectorAll<HTMLElement>("#set-accent [data-accent]")) {
    const on = btn.dataset.accent === current.accent;
    btn.classList.toggle("sel", on);
    btn.setAttribute("aria-pressed", String(on));
  }
}

function showTab(tab: string): void {
  userTab = tab;
  for (const btn of document.querySelectorAll<HTMLElement>("#settings-nav [data-tab]")) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-current", on ? "true" : "false");
  }
  for (const pane of document.querySelectorAll<HTMLElement>("#settings-panes [data-pane]")) {
    pane.hidden = pane.dataset.pane !== tab;
  }
  const noResults = $<HTMLElement>("settings-no-results");
  if (noResults) noResults.hidden = true;
}

function filterRows(query: string): void {
  const q = query.trim().toLowerCase();
  const noResults = $<HTMLElement>("settings-no-results");
  if (!q) {
    for (const row of document.querySelectorAll<HTMLElement>(".pf-set-row")) row.hidden = false;
    for (const btn of document.querySelectorAll<HTMLElement>("#settings-nav [data-tab]")) {
      btn.classList.remove("no-match");
    }
    if (noResults) noResults.hidden = true;
    showTab(userTab);
    return;
  }

  let firstMatch = "";
  for (const pane of document.querySelectorAll<HTMLElement>("#settings-panes [data-pane]")) {
    let matches = 0;
    for (const row of pane.querySelectorAll<HTMLElement>(".pf-set-row")) {
      const hay = `${row.dataset.search ?? ""} ${row.textContent ?? ""}`.toLowerCase();
      const hide = !hay.includes(q);
      row.hidden = hide;
      if (!hide) matches += 1;
    }
    const tab = pane.dataset.pane ?? "";
    const nav = document.querySelector<HTMLElement>(`#settings-nav [data-tab="${tab}"]`);
    nav?.classList.toggle("no-match", matches === 0);
    if (matches && !firstMatch) firstMatch = tab;
  }

  if (firstMatch) {
    showTab(firstMatch);
  } else {
    for (const pane of document.querySelectorAll<HTMLElement>("#settings-panes [data-pane]")) {
      pane.hidden = true;
    }
    if (noResults) noResults.hidden = false;
  }
}

async function refreshEngineStatus(): Promise<void> {
  const status = $<HTMLElement>("set-engine-status");
  const models = $<HTMLElement>("set-model-status");
  const device = $<HTMLElement>("set-ai-device");
  if (status) status.textContent = "检测中…";
  if (models) models.textContent = "—";
  if (device) device.textContent = "—";
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const h = await res.json() as {
      status?: string;
      version?: string;
      jobs_cached?: number;
      models?: Record<string, boolean>;
      ai_device?: { requested?: string; active?: string; fallback?: string | null; onnxruntime?: string | null };
    };
    if (status) status.textContent = `${h.status ?? "ok"} · v${h.version ?? "?"} · ${h.jobs_cached ?? 0} jobs`;
    const m = h.models ?? {};
    if (models) {
      models.textContent = [
        `线稿 ${m.lineart ? "✓" : "✗"}`,
        `U2Net ${m.matting_u2net ? "✓" : "✗"}`,
        `U2NetP ${m.matting_u2netp ? "✓" : "✗"}`,
      ].join(" · ");
    }
    const d = h.ai_device;
    if (device) {
      if (!d) {
        device.textContent = "—";
      } else {
        const label = d.active === "cuda" ? "CUDA"
          : d.active === "dml" ? "DirectML" : "CPU";
        device.textContent = `${label}${d.onnxruntime ? ` · ORT ${d.onnxruntime}` : ""}`;
        device.title = d.fallback
          ? `${d.fallback}（PIXELFORGE_DEVICE=${d.requested ?? "auto"}）`
          : `PIXELFORGE_DEVICE=${d.requested ?? "auto"}`;
      }
    }
  } catch {
    if (status) status.textContent = "离线";
    if (models) models.textContent = "—";
    if (device) device.textContent = "—";
  }
}

async function refreshAudit(): Promise<void> {
  const list = $<HTMLElement>("set-audit-list");
  const empty = $<HTMLElement>("set-audit-empty");
  if (!list) return;
  list.textContent = "";
  try {
    const res = await fetch("/api/agents/audit?limit=30", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as {
      entries?: Array<{ ts: number; agent_id: string; action: string; status: number }>;
    };
    const entries = data.entries ?? [];
    if (!entries.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "pf-audit-row";
      const time = document.createElement("span");
      time.className = "pf-audit-time";
      time.textContent = new Date(e.ts * 1000).toLocaleTimeString();
      const agent = document.createElement("span");
      agent.className = "pf-audit-agent";
      agent.textContent = e.agent_id;
      const action = document.createElement("span");
      action.className = "pf-audit-path";
      action.textContent = e.action;
      action.title = e.action;
      const status = document.createElement("span");
      status.className = "pf-audit-status" + (e.status >= 400 ? " err" : "");
      status.textContent = String(e.status);
      row.append(time, agent, action, status);
      list.appendChild(row);
    }
  } catch {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "审计日志不可用（引擎离线）。";
    }
  }
}

export function openSettings(tab = "general"): void {
  const dlg = $<HTMLDialogElement>("settingsdlg");
  if (!dlg) return;
  const search = $<HTMLInputElement>("settings-search");
  if (search) search.value = "";
  for (const row of document.querySelectorAll<HTMLElement>(".pf-set-row")) row.hidden = false;
  for (const btn of document.querySelectorAll<HTMLElement>("#settings-nav [data-tab]")) {
    btn.classList.remove("no-match");
  }
  showTab(tab);
  syncControls();
  if (!dlg.open) dlg.showModal();
  if (tab === "engine") void refreshEngineStatus();
  if (tab === "mcp") void refreshAudit();
}

export function getSettings(): AppSettings {
  return current;
}

/** 切换界面语言（引导第一步与设置页共用）：即时生效并持久化。 */
export function setLanguage(language: AppSettings["language"]): void {
  if (current.language === language) return;
  current = { ...current, language };
  applyAll(false);
}

function exportSettings(): void {
  const payload = JSON.stringify({
    type: "pixelforge-settings",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: current,
  }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pixelforge-settings.json";
  a.click();
  URL.revokeObjectURL(url);
}

async function importSettings(file: File): Promise<void> {
  const status = $<HTMLElement>("set-import-status");
  try {
    const parsed = JSON.parse(await file.text()) as unknown;
    const raw = parsed && typeof parsed === "object"
      ? (parsed as { settings?: unknown }).settings ?? parsed
      : null;
    if (!raw || typeof raw !== "object") throw new Error("文件格式不正确");
    current = normalize(raw);
    applyAll(true);
    if (status) status.textContent = "设置已导入。";
  } catch (err) {
    if (status) status.textContent = `导入失败：${String(err)}`;
  }
}

/** 装配设置中心；main 在面板初始化后调用一次。 */
export function mountSettings(): void {
  if (mounted) return;
  mounted = true;

  applyAppearance();
  syncControls();
  const version = $("about-version");
  if (version) version.textContent = __APP_VERSION__;

  $("settings-btn")?.addEventListener("click", () => openSettings("general"));
  $("mcp-manager")?.addEventListener("click", () => openSettings("mcp"));
  $("settings-close")?.addEventListener("click", () => {
    $<HTMLDialogElement>("settingsdlg")?.close();
  });
  const dlg = $<HTMLDialogElement>("settingsdlg");
  dlg?.addEventListener("click", (event) => {
    if (event.target === dlg) dlg.close();
  });
  // 搜索框是 type="search"，会吞掉 Esc（原生行为只清空输入），原生 dialog 的 cancel 不触发，
  // 所以在弹窗内统一接管 Esc 关闭。
  dlg?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dlg.close();
  });

  for (const btn of document.querySelectorAll<HTMLElement>("#settings-nav [data-tab]")) {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab ?? "general";
      userTab = tab;
      const search = $<HTMLInputElement>("settings-search");
      if (search) search.value = "";
      filterRows("");
      showTab(tab);
      if (tab === "engine") void refreshEngineStatus();
      if (tab === "mcp") void refreshAudit();
    });
  }

  $<HTMLInputElement>("settings-search")?.addEventListener("input", (event) => {
    filterRows((event.target as HTMLInputElement).value);
  });

  $<HTMLSelectElement>("set-theme")?.addEventListener("change", (event) => {
    current = { ...current, theme: (event.target as HTMLSelectElement).value as ThemeMode };
    applyAll(false);
  });
  $<HTMLSelectElement>("set-language")?.addEventListener("change", (event) => {
    setLanguage((event.target as HTMLSelectElement).value as "zh-CN" | "en-US");
  });
  $<HTMLInputElement>("set-reduce-motion")?.addEventListener("change", (event) => {
    current = { ...current, reduceMotion: (event.target as HTMLInputElement).checked };
    applyAll(false);
  });
  $<HTMLInputElement>("set-high-contrast")?.addEventListener("change", (event) => {
    current = { ...current, highContrast: (event.target as HTMLInputElement).checked };
    applyAll(false);
  });
  $<HTMLInputElement>("set-agent-notify")?.addEventListener("change", (event) => {
    current = { ...current, agentNotifications: (event.target as HTMLInputElement).checked };
    applyAll(false);
  });
  $<HTMLSelectElement>("set-default-preset")?.addEventListener("change", (event) => {
    current = { ...current, defaultPreset: (event.target as HTMLSelectElement).value as DefaultPreset };
    applyAll(true);
  });
  $<HTMLSelectElement>("set-default-size")?.addEventListener("change", (event) => {
    current = { ...current, defaultSize: clampSize((event.target as HTMLSelectElement).value) };
    applyAll(true);
  });
  $<HTMLInputElement>("set-show-grid")?.addEventListener("change", (event) => {
    current = { ...current, showGrid: (event.target as HTMLInputElement).checked };
    applyAll(true);
  });
  for (const btn of document.querySelectorAll<HTMLElement>("#set-accent [data-accent]")) {
    btn.addEventListener("click", () => {
      current = { ...current, accent: (btn.dataset.accent as AccentColor) ?? "green" };
      applyAll(false);
    });
  }

  $("set-engine-refresh")?.addEventListener("click", () => void refreshEngineStatus());
  $("set-audit-refresh")?.addEventListener("click", () => void refreshAudit());
  $("set-export")?.addEventListener("click", exportSettings);
  $("set-import")?.addEventListener("click", () => $<HTMLInputElement>("set-import-file")?.click());
  $<HTMLInputElement>("set-import-file")?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void importSettings(file);
    input.value = "";
  });
  $("set-reset")?.addEventListener("click", () => {
    current = { ...DEFAULT_SETTINGS };
    applyAll(true);
    const status = $<HTMLElement>("set-import-status");
    if (status) status.textContent = "已恢复默认设置。";
  });

  document.addEventListener("pf:open-settings", ((event: Event) => {
    const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab ?? "general";
    openSettings(tab);
  }) as EventListener);

  applyEditorDefaults();
}

applyAppearance();
