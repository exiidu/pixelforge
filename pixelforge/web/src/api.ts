/** 后端客户端（引擎 FastAPI :8700，经 Vite 代理）。 */

export interface ConvertResponse {
  job_id: string;
  width: number;
  height: number;
  palette: [number, number, number][];
  fill: number[][];
  ink: number[][] | null;
  /** M5-0：网格 alpha 灰度 PNG（base64，网格分辨率）；null = 无源透明（导出回退边缘泛洪）。 */
  alpha_png: string | null;
  preview_png: string;
  source_png: string | null;
  meta: { colors_used: number; grid_ms: number; [k: string]: unknown };
  recipe: Record<string, unknown>;
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* 保留默认 */
    }
    throw new Error(`引擎 ${res.status}: ${detail}`);
  }
  return res;
}

/** 配方覆盖（M3 参数面板）：与 target 一并送引擎，深合并到预设配方上。 */
export type RecipeOverrides = Record<string, unknown>;

export async function convertFile(
  file: File,
  preset: string,
  size: number,
  overrides: RecipeOverrides = {},
): Promise<ConvertResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("recipe", preset);
  // preserve_aspect：尺寸=长边，按源图宽高比出网格（非正方形素材不被拉方）
  fd.append("overrides", JSON.stringify({
    ...overrides, target: { width: size, height: size, preserve_aspect: true },
  }));
  const res = await ensureOk(await fetch("/api/convert_file", { method: "POST", body: fd }));
  return res.json();
}

/** 按服务器路径转换（demo 模式 / 后续批量用）。 */
export async function convertPath(
  imagePath: string,
  preset: string,
  size: number,
  overrides: RecipeOverrides = {},
): Promise<ConvertResponse> {
  const res = await ensureOk(
    await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_path: imagePath,
        recipe: preset,
        // preserve_aspect：尺寸=长边，按源图宽高比出网格（非正方形素材不被拉方）
        overrides: { ...overrides, target: { width: size, height: size, preserve_aspect: true } },
      }),
    }),
  );
  return res.json();
}

export async function health(): Promise<{
  status: string;
  presets: string[];
  models: Record<string, boolean>;
}> {
  const res = await ensureOk(await fetch("/api/health"));
  return res.json();
}

export interface LineartResponse {
  mode: string;
  width: number;
  height: number;
  png: string; // 黑线白纸，源图分辨率
  source_png: string | null; // 源图缩略（对比浮层用）
}

/** 独立线稿提取（上传原图）：编辑器文件选择用。 */
export async function extractLineartFile(file: File, mode = "onnx"): Promise<LineartResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", mode);
  const res = await ensureOk(await fetch("/api/lineart_file", { method: "POST", body: fd }));
  return res.json();
}

/** 独立线稿提取（服务器路径）：demo / 路径打开的文件用。 */
export async function extractLineartPath(imagePath: string, mode = "onnx"): Promise<LineartResponse> {
  const res = await ensureOk(
    await fetch("/api/lineart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_path: imagePath, mode }),
    }),
  );
  return res.json();
}

/** M5-1：把前端最终索引网格写成带 PLTE(+tRNS) 的索引 PNG（游戏引擎友好）。 */
export interface IndexedPngResponse {
  png: string;      // base64（无 data: 前缀）
  width: number;
  height: number;
  colors: number;   // 输出调色板颜色数（含透明占位）
  transparent: boolean;
}

export async function exportIndexed(
  palette: [number, number, number][],
  indices: number[][],
  width: number,
  height: number,
): Promise<IndexedPngResponse> {
  const res = await ensureOk(
    await fetch("/api/export_indexed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ palette, indices, width, height }),
    }),
  );
  return res.json();
}

export interface RerunRegionResponse {
  job_id: string;
  width: number;
  height: number;
  palette: [number, number, number][]; // 旧色前缀不变；expand_colors 时尾部追加
  fill: number[][];
  ink: number[][] | null; // 本轮原样保留
  meta: { changed_cells: number; appended_colors: number; region_ms: number; size: [number, number] };
}

/** M4：区域细节重算（regionPng 为网格尺寸白底黑字蒙版；白=重算）。 */
export async function rerunRegion(
  jobId: string,
  regionPng: string,
  paramDelta: Record<string, unknown> = {},
  expandColors = 0,
): Promise<RerunRegionResponse> {
  const res = await ensureOk(
    await fetch("/api/rerun_region", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        region_png: regionPng,
        param_delta: paramDelta,
        expand_colors: expandColors,
      }),
    }),
  );
  return res.json();
}
