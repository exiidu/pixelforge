/** 通用确认框：返回 Promise<boolean>，支持 Esc / 背景点击取消。 */
import { getLocale, t } from "./i18n";

interface ConfirmOptions {
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
}

interface PromptOptions {
  title?: string;
  label: string;
  value?: string;
  okText?: string;
  cancelText?: string;
  maxLength?: number;
}

let mounted = false;
let pending: ((value: boolean) => void) | null = null;
let pendingPrompt: ((value: string | null) => void) | null = null;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function settle(value: boolean): void {
  const resolve = pending;
  pending = null;
  el<HTMLDialogElement>("confirmdlg")?.close();
  resolve?.(value);
}

function settlePrompt(value: string | null): void {
  const resolve = pendingPrompt;
  pendingPrompt = null;
  el<HTMLDialogElement>("promptdlg")?.close();
  resolve?.(value);
}

/** 0.10.0：单行输入框（重命名等）；Enter 确认、Esc/背景点击取消。 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  const dlg = el<HTMLDialogElement>("promptdlg");
  const input = el<HTMLInputElement>("prompt-input");
  if (!dlg || !input) return Promise.resolve(null);
  if (pendingPrompt) settlePrompt(null);

  const title = el("prompt-title");
  const label = el("prompt-label");
  const ok = el("prompt-ok");
  const cancel = el("prompt-cancel");
  if (title) title.textContent = opts.title ?? t("确认");
  if (label) label.textContent = opts.label;
  if (ok) ok.textContent = opts.okText ?? t("确定");
  if (cancel) cancel.textContent = opts.cancelText ?? t("取消");
  input.maxLength = opts.maxLength ?? 60;
  input.value = opts.value ?? "";

  if (dlg.open) dlg.close();
  dlg.showModal();
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return new Promise((resolve) => {
    pendingPrompt = resolve;
  });
}

/** 打开确认框；重复调用会把上一次视为取消。 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const dlg = el<HTMLDialogElement>("confirmdlg");
  if (!dlg) return Promise.resolve(false);
  if (pending) settle(false);

  const title = el("confirm-title");
  const message = el("confirm-message");
  const ok = el("confirm-ok");
  const cancel = el("confirm-cancel");
  if (title) title.textContent = opts.title ?? t("确认");
  if (message) message.textContent = opts.message;
  if (ok) ok.textContent = opts.okText ?? t("确定");
  if (cancel) cancel.textContent = opts.cancelText ?? t("取消");

  if (dlg.open) dlg.close();
  dlg.showModal();
  return new Promise((resolve) => {
    pending = resolve;
  });
}

/** 关闭前的未保存确认：单文档或多文档。 */
export function confirmDiscard(names: string[]): Promise<boolean> {
  const unique = Array.from(new Set(names.filter(Boolean)));
  if (!unique.length) return Promise.resolve(true);
  const en = getLocale() === "en-US";
  const message = unique.length > 1
    ? (en
      ? `${unique.length} documents have unsaved manual edits that will be lost. Close anyway?`
      : `有 ${unique.length} 个文档有未保存的手改，关闭后会丢失。仍要关闭吗？`)
    : (en
      ? `“${unique[0]}” has unsaved manual edits that will be lost. Close anyway?`
      : `「${unique[0]}」有未保存的手改，关闭后会丢失。仍要关闭吗？`);
  return confirmDialog({
    title: t("未保存的更改"),
    message,
    okText: t("仍然关闭"),
    cancelText: t("取消"),
  });
}

export function mountDialogs(): void {
  if (mounted) return;
  mounted = true;
  const dlg = el<HTMLDialogElement>("confirmdlg");
  dlg?.addEventListener("cancel", (event) => {
    event.preventDefault();
    settle(false);
  });
  dlg?.addEventListener("click", (event) => {
    if (event.target === dlg) settle(false);
  });
  el("confirm-ok")?.addEventListener("click", () => settle(true));
  el("confirm-cancel")?.addEventListener("click", () => settle(false));

  const prompt = el<HTMLDialogElement>("promptdlg");
  const promptInput = el<HTMLInputElement>("prompt-input");
  prompt?.addEventListener("cancel", (event) => {
    event.preventDefault();
    settlePrompt(null);
  });
  prompt?.addEventListener("click", (event) => {
    if (event.target === prompt) settlePrompt(null);
  });
  el("prompt-ok")?.addEventListener("click", () => settlePrompt(promptInput?.value.trim() || null));
  el("prompt-cancel")?.addEventListener("click", () => settlePrompt(null));
  promptInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    settlePrompt(promptInput.value.trim() || null);
  });
}
