/** MCP-3B：按文档 jobId 订阅引擎 job WebSocket，把 agent 的服务端编辑同步到编辑器。
 *
 * 一个 job 一个连接；文档关闭或重转换换 jobId 时自动解绑/重连。
 * 应用策略由 main.ts 的 onUpdate 负责（服务端 base 更新 + 本地手改保留）。
 */

import { getState, subscribe, type EditorDoc } from "./store";

export interface JobWsPayload {
  type: "job_snapshot" | "job_update";
  job_id: string;
  revision: number;
  action?: string;
  name?: string;
  width: number;
  height: number;
  fill: number[][];
  ink: number[][] | null;
  palette: [number, number, number][];
  alpha_png: string | null;
  ink_visible?: boolean;
}

interface SocketEntry {
  ws: WebSocket;
  retryMs: number;
  timer: number;
}

const sockets = new Map<string, SocketEntry>();

function docsForJob(jobId: string): EditorDoc[] {
  return getState().docs.filter((d) => d.jobId === jobId && !d.lineart);
}

function connect(jobId: string, onUpdate: (doc: EditorDoc, payload: JobWsPayload) => void | Promise<void>): void {
  if (sockets.has(jobId)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/jobs/${encodeURIComponent(jobId)}`);
  const entry: SocketEntry = { ws, retryMs: 1000, timer: 0 };
  sockets.set(jobId, entry);

  ws.onmessage = (event) => {
    let payload: JobWsPayload;
    try {
      payload = JSON.parse(String(event.data)) as JobWsPayload;
    } catch {
      return;
    }
    if (!payload || payload.job_id !== jobId) return;
    for (const doc of docsForJob(jobId)) {
      void Promise.resolve(onUpdate(doc, payload)).catch(() => {
        /* 单次应用失败不关闭订阅；下一 revision 仍会到达 */
      });
    }
  };

  ws.onopen = () => {
    entry.retryMs = 1000;
  };

  ws.onerror = () => {
    /* 浏览器会自动触发 onclose 并进入重连 */
  };

  ws.onclose = (event) => {
    sockets.delete(jobId);
    if (event.code === 1008) return; // job 已被淘汰/不存在：不再重连
    if (!docsForJob(jobId).length) return;
    const delay = entry.retryMs;
    entry.retryMs = Math.min(8000, Math.round(entry.retryMs * 1.6));
    entry.timer = window.setTimeout(() => connect(jobId, onUpdate), delay);
  };
}

/** 装配 job 实时同步；随 store 变化自动增删连接。 */
export function mountJobSync(
  onUpdate: (doc: EditorDoc, payload: JobWsPayload) => void | Promise<void>,
): void {
  const reconcile = () => {
    const desired = new Set(
      getState().docs
        .filter((d) => !!d.jobId && !d.lineart)
        .map((d) => d.jobId),
    );

    for (const [jobId, entry] of sockets) {
      if (desired.has(jobId)) continue;
      window.clearTimeout(entry.timer);
      try {
        entry.ws.close();
      } catch {
        /* 已关闭 */
      }
      sockets.delete(jobId);
    }

    for (const jobId of desired) connect(jobId, onUpdate);
  };

  subscribe(reconcile);
  reconcile();
}
