/** MCP / Agent 管理界面：控制蒙版、已接入 Agent 列表、功能权限配置。
 *
 * 目前由前端事件驱动（`?agentDemo=1` 或 `pf:agent-control` 自定义事件），
 * MCP-3B 接入 job/WS 后只需调用 `setAgentControl` / `registerMcpAgent`。
 */

import { onLocaleChange, t } from "./i18n";

export interface McpFeatureDef {
  id: string;
  label: string;
  desc: string;
  tools: string;
}

export const MCP_FEATURES: McpFeatureDef[] = [
  { id: "convert", label: "转换与批量", desc: "单图 / 批量转换为像素画", tools: "convert · convert_batch" },
  { id: "inspect", label: "读取与检查", desc: "读取网格、单格颜色与统计", tools: "get_grid · get_pixel · result_info" },
  { id: "edit", label: "像素编辑", desc: "批量写格、区域泛洪填充", tools: "draw_pixels · fill_region" },
  { id: "palette", label: "调色板变换", desc: "OKLab 明度 / 色相 / 饱和度", tools: "palette_transform" },
  { id: "rerun", label: "局部重算", desc: "按矩形 / 格集合重跑采样", tools: "rerun_region" },
  { id: "export", label: "导出", desc: "合成 RGBA / 索引 PNG", tools: "export · export_stage" },
  { id: "recipes", label: "配方存取", desc: "保存、读取、列出配方", tools: "list_recipes · save_recipe · get_recipe" },
  { id: "ai", label: "AI 辅助", desc: "独立线稿提取与主体抠图", tools: "extract_lineart · remove_background" },
];

export interface McpAgent {
  id: string;
  name: string;
  subtitle: string;
  status: "connected" | "offline";
  controlling?: boolean;
  activity?: string;
  features: Record<string, boolean>;
  /** 演示/临时 Agent：刷新后不保留。 */
  ephemeral?: boolean;
}

export interface RemoteAgent {
  id: string;
  name: string;
  subtitle?: string;
  status: "connected" | "offline";
  controlling?: boolean;
  activity?: string;
  features?: Record<string, boolean>;
}

export interface AgentControlOptions {
  agentId?: string;
  agentName?: string;
  activity?: string;
}

const FEATURE_KEY = "pf.mcp.features.v1";
let agents: McpAgent[] = [];
let selectedId = "";
let mounted = false;

function defaultFeatures(): Record<string, boolean> {
  return Object.fromEntries(MCP_FEATURES.map((f) => [f.id, true]));
}

function normalizeFeatures(raw: unknown): Record<string, boolean> {
  const out = defaultFeatures();
  if (raw && typeof raw === "object") {
    const source = raw as Record<string, unknown>;
    for (const f of MCP_FEATURES) {
      if (typeof source[f.id] === "boolean") out[f.id] = source[f.id] as boolean;
    }
  }
  return out;
}

function loadFeatureConfig(): Record<string, Record<string, boolean>> {
  try {
    const raw = localStorage.getItem(FEATURE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, Record<string, boolean>> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[id] = normalizeFeatures(value);
    }
    return out;
  } catch {
    return {};
  }
}

function saveFeatureConfig(agent: McpAgent): void {
  if (agent.ephemeral) return;
  try {
    const all = loadFeatureConfig();
    all[agent.id] = { ...agent.features };
    localStorage.setItem(FEATURE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage 不可用时静默忽略：UI 仍在内存中生效 */
  }
  void pushAgentFeatures(agent);
}

async function pushAgentFeatures(agent: McpAgent): Promise<void> {
  if (agent.ephemeral) return;
  try {
    await fetch("/api/agents/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agent.id, features: agent.features }),
    });
  } catch {
    /* 引擎离线时仅保留本地配置 */
  }
}

async function releaseAgentOnServer(agent: McpAgent | undefined): Promise<void> {
  if (!agent || agent.ephemeral) return;
  try {
    await fetch("/api/agents/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agent.id, active: false }),
    });
  } catch {
    /* 引擎离线时仅本地隐藏蒙版 */
  }
}

function makeAgent(id: string, name: string, subtitle: string, status: McpAgent["status"]): McpAgent {
  return {
    id,
    name,
    subtitle,
    status,
    features: loadFeatureConfig()[id] ?? defaultFeatures(),
  };
}

function ensureLocalAgent(): McpAgent {
  let agent = agents.find((a) => a.id === "local-mcp");
  if (!agent) {
    agent = makeAgent("local-mcp", "本地 MCP", "stdio · 未连接", "offline");
    agents.push(agent);
  }
  return agent;
}

function ensureDemoAgent(): McpAgent {
  let agent = agents.find((a) => a.id === "demo-zcode");
  if (!agent) {
    agent = {
      id: "demo-zcode",
      name: "ZCode",
      subtitle: "MCP · 演示会话",
      status: "connected",
      features: defaultFeatures(),
      ephemeral: true,
    };
    agents.push(agent);
  }
  return agent;
}

function agentById(id: string): McpAgent | undefined {
  return agents.find((a) => a.id === id);
}

function updateEntry(): void {
  const btn = document.getElementById("mcp-manager");
  if (!btn) return;
  const dot = btn.querySelector(".dot");
  const busy = agents.some((a) => a.controlling);
  const online = agents.some((a) => a.status === "connected");
  dot?.classList.toggle("busy", busy);
  dot?.classList.toggle("on", !busy && online);
  const connected = agents.filter((a) => a.status === "connected").length;
  btn.title = busy
    ? "Agent 正在控制编辑器（点击查看 MCP 管理）"
    : connected
      ? `MCP：${connected} 个 Agent 在线`
      : "管理 MCP / Agent 接入";

  const summary = document.getElementById("mcp-summary");
  if (summary) {
    const controlling = agents.filter((a) => a.controlling).length;
    summary.textContent = connected
      ? `已接入 ${connected} 个 Agent${controlling ? ` · ${controlling} 个正在控制` : ""}。`
      : "暂无已连接 Agent。启动 MCP 客户端后会自动出现在这里。";
  }
}

function renderAgentList(): void {
  const list = document.getElementById("mcp-agent-list");
  if (!list) return;
  list.textContent = "";
  for (const agent of agents) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pf-mcp-agent";
    if (agent.id === selectedId) row.classList.add("sel");
    if (agent.status === "offline") row.classList.add("offline");
    row.addEventListener("click", () => {
      selectedId = agent.id;
      renderAgentList();
      renderFeatures();
    });

    const avatar = document.createElement("span");
    avatar.className = "pf-mcp-avatar";
    avatar.textContent = (t(agent.name).trim().charAt(0) || "A").toUpperCase();

    const meta = document.createElement("span");
    meta.className = "pf-mcp-meta";
    const name = document.createElement("span");
    name.className = "pf-mcp-name";
    name.textContent = agent.name;
    const sub = document.createElement("span");
    sub.className = "pf-mcp-sub";
    sub.textContent = agent.controlling && agent.activity ? `正在执行：${agent.activity}` : agent.subtitle;
    meta.append(name, sub);

    const state = document.createElement("span");
    state.className = "pf-mcp-state";
    if (agent.controlling) state.classList.add("busy");
    else if (agent.status === "connected") state.classList.add("on");
    const stateDot = document.createElement("i");
    const stateText = document.createElement("span");
    stateText.textContent = agent.controlling ? "控制中" : agent.status === "connected" ? "在线" : "未连接";
    state.append(stateDot, stateText);

    row.append(avatar, meta, state);
    list.append(row);
  }
}

function renderFeatures(): void {
  const list = document.getElementById("mcp-feature-list");
  const empty = document.getElementById("mcp-perm-empty");
  const label = document.getElementById("mcp-perm-agent");
  if (!list || !empty || !label) return;
  const agent = agentById(selectedId);
  list.textContent = "";
  if (!agent) {
    empty.hidden = false;
    label.textContent = "";
    return;
  }
  empty.hidden = true;
  label.textContent = `· ${agent.name}`;

  for (const feature of MCP_FEATURES) {
    const row = document.createElement("label");
    row.className = "pf-mcp-feature";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = agent.features[feature.id] !== false;
    cb.addEventListener("change", () => {
      agent.features[feature.id] = cb.checked;
      saveFeatureConfig(agent);
      updateEntry();
      document.dispatchEvent(new CustomEvent("pf:mcp-features", {
        detail: { agentId: agent.id, features: { ...agent.features } },
      }));
    });

    const text = document.createElement("span");
    text.className = "txt";
    const title = document.createElement("b");
    title.textContent = feature.label;
    const desc = document.createElement("span");
    desc.textContent = feature.desc;
    const tools = document.createElement("code");
    tools.textContent = feature.tools;
    text.append(title, desc, tools);

    row.append(cb, text);
    list.append(row);
  }
}

function renderAll(): void {
  renderAgentList();
  renderFeatures();
  updateEntry();
}

/** 显示/隐藏 Agent 控制蒙版。MCP-3B 的真实控制事件可直接调用它。 */
export function setAgentControl(active: boolean, opts: AgentControlOptions = {}): void {
  const overlay = document.getElementById("agent-overlay");
  if (!overlay) return;

  if (active) {
    // 控制期间关闭已打开的模态窗，避免它们在 top layer 越过蒙版继续操作
    for (const dlg of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dlg.close();
    let agent = opts.agentId ? agentById(opts.agentId) : undefined;
    if (!agent && opts.agentName) {
      agent = makeAgent(
        `agent-${opts.agentName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "remote"}`,
        opts.agentName,
        "MCP · 远程会话",
        "connected",
      );
      agents.push(agent);
    }
    agent ??= agents.find((a) => a.status === "connected") ?? ensureLocalAgent();
    agent.status = "connected";
    agent.controlling = true;
    agent.activity = opts.activity || "";
    selectedId = agent.id;

    const title = document.getElementById("agent-title");
    const activity = document.getElementById("agent-activity");
    if (title) title.textContent = `${agent.name} 正在控制编辑器`;
    if (activity) activity.textContent = opts.activity ? `正在执行：${opts.activity}` : "正在执行任务…";
    overlay.hidden = false;
    renderAll();
    document.getElementById("agent-release")?.focus();
  } else {
    for (const agent of agents) {
      agent.controlling = false;
      agent.activity = "";
    }
    overlay.hidden = true;
    renderAll();
  }
}

/** 注册/更新一个已接入的 Agent；MCP-3B 的 WS 事件可调用。 */
export function registerMcpAgent(input: {
  id: string;
  name: string;
  subtitle?: string;
  status?: McpAgent["status"];
  features?: Record<string, boolean>;
}): McpAgent {
  let agent = agentById(input.id);
  if (!agent) {
    agent = makeAgent(input.id, input.name, input.subtitle ?? "MCP · 已接入", input.status ?? "connected");
    agents.push(agent);
  }
  agent.name = input.name;
  if (input.subtitle) agent.subtitle = input.subtitle;
  if (input.status) agent.status = input.status;
  if (input.features) agent.features = normalizeFeatures(input.features);
  renderAll();
  return agent;
}

let syncTimer = 0;
let syncSignature = "";

/** 把引擎 `/api/agents` 的 Agent 列表/控制状态合并到 UI；MCP-3B 实时轮询用。 */
export function syncMcpAgents(remote: RemoteAgent[]): void {
  const signature = JSON.stringify(remote.map((a) => [
    a.id, a.name, a.subtitle, a.status, !!a.controlling, a.activity || "", a.features || {},
  ]));
  if (signature === syncSignature) return;
  syncSignature = signature;

  const remoteIds = new Set(remote.map((a) => a.id));
  for (const agent of agents) {
    if (!agent.ephemeral && !remoteIds.has(agent.id)) {
      agent.status = "offline";
      agent.controlling = false;
      agent.activity = "";
    }
  }

  for (const item of remote) {
    let agent = agentById(item.id);
    if (!agent) {
      agent = makeAgent(item.id, item.name, item.subtitle ?? "MCP · 已接入", item.status);
      agents.push(agent);
    }
    agent.name = item.name;
    agent.subtitle = item.subtitle || "MCP · 已接入";
    agent.status = item.status;
    agent.controlling = !!item.controlling;
    agent.activity = item.activity || "";
    if (item.features && Object.keys(item.features).length) {
      agent.features = normalizeFeatures(item.features);
    }
  }

  const controlling = agents.find((a) => a.controlling);
  const overlay = document.getElementById("agent-overlay");
  if (controlling) {
    selectedId = controlling.id;
    if (!overlay || overlay.hidden) {
      setAgentControl(true, {
        agentId: controlling.id,
        activity: controlling.activity || "正在执行任务",
      });
    } else {
      const title = document.getElementById("agent-title");
      const activity = document.getElementById("agent-activity");
      if (title) title.textContent = `${controlling.name} 正在控制编辑器`;
      if (activity) activity.textContent = `正在执行：${controlling.activity || "任务"}`;
      renderAll();
    }
  } else if (overlay && !overlay.hidden) {
    setAgentControl(false);
  } else {
    renderAll();
  }
}

/** 轮询引擎 Agent 状态；引擎离线时静默保持本地占位状态。 */
export function startAgentSync(intervalMs = 1500): void {
  if (syncTimer) return;
  const tick = async () => {
    try {
      const res = await fetch("/api/agents", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as { agents?: RemoteAgent[] };
      syncMcpAgents(Array.isArray(data.agents) ? data.agents : []);
    } catch {
      /* 引擎离线：保留当前状态 */
    }
  };
  void tick();
  syncTimer = window.setInterval(tick, intervalMs);
}

export function openMcpManager(): void {
  document.dispatchEvent(new CustomEvent("pf:open-settings", {
    detail: { tab: "mcp" },
  }));
}

export function getMcpAgents(): McpAgent[] {
  return agents.map((a) => ({ ...a, features: { ...a.features } }));
}

/** 装配入口：绑定左下角按钮、管理窗和解除控制。 */
export function mountMcpUi(opts: { demo?: boolean } = {}): void {
  if (mounted) return;
  mounted = true;

  ensureLocalAgent();
  selectedId = agents[0]?.id ?? "";
  if (opts.demo) selectedId = ensureDemoAgent().id;

  document.getElementById("agent-release")?.addEventListener("click", () => {
    const active = agents.find((a) => a.controlling);
    void releaseAgentOnServer(active);
    setAgentControl(false);
    document.dispatchEvent(new CustomEvent("pf:agent-released", {
      detail: { agentId: active?.id ?? "" },
    }));
  });

  // 供未来 MCP-3B 或外部脚本通过事件驱动蒙版
  document.addEventListener("pf:agent-control", ((event: Event) => {
    const detail = (event as CustomEvent<{ active?: boolean } & AgentControlOptions>).detail || {};
    setAgentControl(detail.active !== false, detail);
  }) as EventListener);

  // 蒙版期间拦截键盘快捷键；仅放行结束按钮的 Tab / Enter / Space
  const blockKeys = (event: Event) => {
    const overlay = document.getElementById("agent-overlay");
    if (!overlay || overlay.hidden) return;
    const target = event.target as Element | null;
    const inCard = !!target?.closest?.(".pf-agent-card");
    const key = event instanceof KeyboardEvent ? event.key : "";
    const allow = inCard && (key === "Tab" || key === "Enter" || key === " ");
    if (allow) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener("keydown", blockKeys, true);
  document.addEventListener("keyup", blockKeys, true);

  renderAll();
  // 头像首字母由 Agent 名称派生，切换语言后需重渲染（名称本身由 i18n 观察器翻译）。
  onLocaleChange(() => renderAll());

  if (opts.demo) {
    setAgentControl(true, {
      agentId: "demo-zcode",
      activity: "正在批量转换 3 张图片",
    });
  } else {
    startAgentSync();
  }
}
