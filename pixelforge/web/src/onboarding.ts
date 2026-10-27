/** A2 首次启动引导：四步介绍「语言 → 打开 → 转换 → 手改/导出」。
 *
 * 只在“第一次启动且没有已恢复文档”时自动弹出；完成后写入 localStorage。
 * 可用 `?onboarding=1` 强制重看（方便验收与演示）。
 */
import { getState } from "./store";
import { openSampleProject } from "./sample";
import { onLocaleChange, t } from "./i18n";
import { getSettings, setLanguage } from "./settings";

const KEY = "pf.onboarding.v1";
const STEPS = 4;

let mounted = false;
let step = 0;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function markSeen(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* localStorage 不可用时仅本次生效 */
  }
}

/** 语言选择按钮的选中态跟随当前设置（切换语言后也同步）。 */
function syncLanguage(): void {
  const lang = getSettings().language;
  el("ob-lang-zh")?.setAttribute("aria-pressed", String(lang === "zh-CN"));
  el("ob-lang-en")?.setAttribute("aria-pressed", String(lang === "en-US"));
}

function renderStep(): void {
  const kicker = el("ob-kicker");
  // 这两处是运行期写入的动态文案，用 t() 直接产出目标语言，避免依赖 DOM 观察器的时序。
  if (kicker) kicker.textContent = t(`第 ${step + 1} / ${STEPS} 步`);
  for (const pane of document.querySelectorAll<HTMLElement>("#onboarddlg [data-ob-step]")) {
    pane.hidden = Number(pane.dataset.obStep) !== step;
  }
  for (const dot of document.querySelectorAll<HTMLElement>("#onboarddlg .pf-ob-dots span")) {
    dot.classList.toggle("on", Array.from(dot.parentElement?.children ?? []).indexOf(dot) === step);
  }
  const prev = el<HTMLButtonElement>("ob-prev");
  if (prev) prev.disabled = step === 0;
  const next = el<HTMLButtonElement>("ob-next");
  if (next) next.textContent = t(step === STEPS - 1 ? "开始使用" : "下一步");
}

/** 打开引导（从第 1 步开始）。 */
export function openOnboarding(): void {
  const dlg = el<HTMLDialogElement>("onboarddlg");
  if (!dlg) return;
  step = 0;
  renderStep();
  if (!dlg.open) dlg.showModal();
}

export function mountOnboarding(): void {
  if (mounted) return;
  mounted = true;

  const dlg = el<HTMLDialogElement>("onboarddlg");
  const finish = (): void => {
    markSeen();
    dlg?.close();
  };

  el("ob-lang-zh")?.addEventListener("click", () => setLanguage("zh-CN"));
  el("ob-lang-en")?.addEventListener("click", () => setLanguage("en-US"));
  onLocaleChange(() => {
    syncLanguage();
    renderStep();
  });
  syncLanguage();

  el("ob-skip")?.addEventListener("click", finish);
  el("ob-prev")?.addEventListener("click", () => {
    step = Math.max(0, step - 1);
    renderStep();
  });
  el("ob-next")?.addEventListener("click", () => {
    if (step >= STEPS - 1) {
      finish();
      return;
    }
    step++;
    renderStep();
  });
  el("ob-open")?.addEventListener("click", () => {
    finish();
    el("open")?.click();
  });
  el("ob-sample")?.addEventListener("click", () => {
    finish();
    openSampleProject();
  });
  dlg?.addEventListener("click", (event) => {
    if (event.target === dlg) finish();
  });
  dlg?.addEventListener("close", markSeen);

  const forced = new URLSearchParams(location.search).get("onboarding") === "1";
  if (forced) {
    setTimeout(() => openOnboarding(), 250);
    return;
  }
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  // 等会话恢复询问落定：有弹窗或有文档时不再打扰老用户。
  setTimeout(() => {
    try {
      if (localStorage.getItem(KEY)) return;
    } catch {
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    if (getState().docs.length) return;
    openOnboarding();
  }, 1200);
}
