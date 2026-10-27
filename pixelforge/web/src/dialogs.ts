/** 通用确认框：返回 Promise<boolean>，支持 Esc / 背景点击取消。 */
import { getLocale, t } from "./i18n";

interface ConfirmOptions {
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
}

let mounted = false;
let pending: ((value: boolean) => void) | null = null;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function settle(value: boolean): void {
  const resolve = pending;
  pending = null;
  el<HTMLDialogElement>("confirmdlg")?.close();
  resolve?.(value);
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
}
