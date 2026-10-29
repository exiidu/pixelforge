# Changelog

本项目遵循语义化版本；日期为发布日。

## 0.11.0 — 2026-10-29

### Added
- 免 Python 安装包（Windows x64）：`tools/build_standalone.py` 生成
  `dist/pixelforge-<version>-windows-x64-noinstall.zip`，内置 Python 3.12 运行时与全部依赖，
  解压后双击 `PixelForge.bat` 即可运行，无需安装 Python 或 Node。
- 包内附带 `download_models.bat`（调用内置 Python 下载 AI 模型）与 MSVC 运行库，提升干净系统兼容性。
- 内置运行时隔离宿主机用户级 Python 包（`PYTHONNOUSERSITE=1`），避免版本冲突。

### Changed
- 免 Python 包不含模型权重与用户数据；会话/日志仍写入系统数据目录，可用 `PIXELFORGE_DATA_DIR` 覆盖。
- 免 Python 包当前仅支持 Windows x64；macOS/Linux 仍使用便携 zip + 系统 Python。

## 0.10.0 — 2026-10-28

### Added
- 批量导入结果对话框：逐项显示成功/失败/重复源图，失败项可一键重试，可下载 JSON 导入报告。
- 拖拽打开：图片批量拖入导入；拖入单个 `.pixelforge` 直接打开项目（多个项目会提示）。
- 导出预设记忆：格式、缩放、透明、命名模板、精灵图集设置在下次打开导出时自动恢复。
- 精灵图集导出同时生成 `.atlas.json`（图片名、尺寸、缩放、帧坐标）。
- 标签右键菜单新增「重命名…」。
- 调色板「可辨性检查」：按 OKLab 色差找出过于接近的颜色对（阈值 0.08），结果显示在状态栏。

## 0.9.0 — 2026-10-28

### Added
- 数据目录：会话、上传缓存、日志从安装目录迁出，默认 `%LOCALAPPDATA%\\PixelForge`（macOS/Linux 有对应目录），可用 `PIXELFORGE_DATA_DIR` 指定；旧版 `web/session.json` 仍可回退读取。
- 日志落盘（2 MB × 3 轮转）与 `GET /api/diagnostics`；设置 → 引擎新增「导出诊断包」。
- 会话备份：每次自动保存前保留上一份 `session.json.bak`，主文件损坏时自动回退。
- 统一错误封包 `{error: {code, message}}`；前端不再直接显示后端异常/堆栈。
- 引擎离线/恢复轮询提示；未捕获的前端异常落到状态栏与日志。
- 删除图层二次确认（可撤销）。

### Changed
- 上传缓存与会话文件位置变更；旧会话仍在首次读取时兼容。

## 0.8.0 — 2026-10-27

### Added
- 单进程运行：存在 `web/dist` 时引擎直接托管前端，`http://127.0.0.1:8700/` 即可使用编辑器，无需 Node/Vite。
- `start_all.bat` / `start_all.sh` 自动分流：有构建产物只启动引擎；没有则回退 Vite 开发服务器。
- `pixelforge/tools/build_release.py`：构建便携包 `dist/pixelforge-<version>-portable.zip`（引擎 + 前端 dist + 启动脚本，排除模型与缓存）。

### Changed
- 健康检查新增 `web_dist` 状态；README 增加便携包与单进程说明。
- 便携包仍需要 Python 环境；免 Python 安装包仍在路线图。

## 0.7.0 — 2026-10-27

### Added
- Agent 操作审计：MCP 请求携带 Agent 标识，引擎记录写操作（时间、Agent、方法+路径、状态码）；`GET /api/agents/audit` 可在「设置 → MCP / Agent → 最近操作」查看并刷新。

### Security
- 会话保存增加 8MB 上限（413），避免超大 JSON 写入。
- Agent 标识/名称/副标题与权限表条目数限制长度；上传文件名限制长度。
- MCP 引擎地址仍强制回环白名单，禁止跟随重定向。

## 0.6.0 — 2026-10-27

### Added
- 批量导入可取消：进度窗新增「取消」，中止当前请求并停止后续文件，状态栏汇总已完成数量。

### Changed
- `/api/convert_file` 改在线程池执行，转换期间健康检查、任务列表与 WebSocket 保持响应。
- 管线调用统一串行化，保护 S0/S1 缓存并避免并发 GPU 推理造成显存峰值。
- S0/S1 预计算缓存改为 LRU（上限 4），批量导入不再随图片数增长内存。

## 0.5.0 — 2026-10-27

### Added
- 高对比度模式（设置 → 外观）：加强文字、边框与焦点环对比，偏好持久化。
- 全局可见的键盘焦点环；标签栏支持 ←/→/Home/End 切换、Shift+F10 打开标签菜单。
- 调色板与自定义色架色块改为按钮，可用 Tab 聚焦、Enter/空格 取色；图层行支持键盘激活。
- 读屏支持：状态栏改为实时区域，画布关联状态描述，工具按钮补充名称与按下状态。
- 帮助中心新增「可访问性」分类；README 补充可访问性说明。

### Changed
- 所有对话框补充 `aria-labelledby` / 标签，弹窗关闭后焦点回到原位置（原生 dialog 行为）。

## 0.4.1 — 2026-10-27

### Fixed
- Windows 启动脚本 `start_all.bat` / `start_engine.bat` 以 LF 行尾保存时，`cmd` 解析 `goto`/标签失败，双击后窗口一闪而过。已改为 CRLF，并新增 `.gitattributes` 固定检出行为。

## 0.4.0 — 2026-10-27

### Added
- AI 推理 GPU 加速：线稿与主体抠图按 `PIXELFORGE_DEVICE`（`auto|cuda|dml|cpu`）选择 CUDA / DirectML / CPU，不可用时自动回退。
- 设置 → 引擎新增「AI 运行设备」；`/api/health` 返回实际设备、可用 Provider 与回退原因。
- 可选安装项 `gpu`（onnxruntime-gpu）与 `directml`（onnxruntime-directml）。

### Performance
- S2 加权采样改为“小网格稠密 / 大网格稀疏”混合直方图：512 格由 ~5.4s 降至 ~1.0s，内存从 ~500MB 级降到几十 MB。
- S3 调色板提取与最近色映射改用 BLAS 距离 + 分块计算，并加速唯一色提取；512 格由 ~2.6s 降至 ~0.6s。
- 2048×1536 输入、512 格的整条管线由 ~7.4s 降至 ~1.8s（本机 CPU 实测）；64/128 格的输出与 0.3.0 逐位一致。

### Documentation
- README 增加 GPU 安装与性能说明；models/README 补充 CUDA / DirectML 运行依赖。

## 0.3.0 — 2026-10-27

### Added
- `.pixelforge` 项目文件：保存当前文档的配方、图层、手改、调色板、细节标记与源图（内嵌 base64），可换机器继续编辑。
- 顶栏「项目…」「保存」入口；最近项目列表（localStorage `pf.projects.v1`），可一键重开或从列表移除。
- 原位保存：支持 File System Access 的浏览器可直接覆盖项目文件；其余浏览器回退为下载。
- 快捷键：`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+Shift+S` 另存为、`Ctrl/Cmd+O` 打开项目。
- 缺少源图的项目/会话文档可重新绑定源图文件，恢复重转换与引擎线稿导出。
- 关闭标签（单关、中键、关闭其他、关闭右侧）与离开页面时，对未保存手改进行确认。

### Changed
- 保存项目后标签的未保存标记清除，项目名与保存时间记录在文档上。

## 0.2.1 — 2026-10-27

### Fixed
- 设置 → 关于改为显示实际版本（由 `package.json` 注入），不再固定为 0.1.0。
- 许可证与第三方模型说明与发布状态一致；移除未打包的 rembg 误列。

### Documentation
- 修正快速开始命令与克隆地址；补充 CI 徽章、macOS/Linux 启动命令与 Node 版本要求。
- 工具数量更正为 13；MCP 配置示例补充 `<repo>` 路径说明。

## 0.2.0 — 2026-10-27

首个公开版本。

### 转换引擎
- 确定性管线 S0–S5：预处理、结构/线稿、加权众数采样、OKLab 调色板量化、墨线合成、后处理。
- 分层输出 Fill / Ink / 调色板；索引 PNG（PLTE + tRNS）与真透明 alpha 网格。
- 非正方形素材保持宽高比；亮部对比、色板锁定、配方 JSON 导入导出。

### 编辑器
- 多文档标签、13 种工具、逻辑图层栈、手改层与跨尺寸索引重绑。
- 撤销/重做、选区与磁力套索、笔刷/对称、描图底图、会话自动保存与恢复。
- 调色板排序/锁定/单色编辑、OKLab 色板变换、`.hex` / `.gpl` 导入导出。
- 批量导入导出、索引 PNG、引擎线稿、像素墨线层、精灵图集与命名模板。
- 细节笔刷 + 局部重算（只写回标记格，可撤销）。

### MCP 与 Agent
- MCP 服务器 19 个工具：转换、批量、配方、网格读写、填充、调色板、局部重算、导出、任务列表。
- Agent 注册/心跳/控制/功能权限；编辑器控制蒙版与解除控制。
- `WS /api/jobs/{id}` 实时同步，job revision 乐观锁与 Agent 更新徽章。

### 产品化
- 全局设置中心（主题、强调色、减少动效、默认参数、Agent 通知、导入/导出/重置）。
- 中英双语界面（即时切换、持久化）；帮助中心（9 分类）与首次启动 4 步引导（语言优先）。
- 内置程序化示例项目；空状态与帮助入口。

### 安全
- CORS 限制为本机来源（可用 `PIXELFORGE_CORS_ORIGINS` 扩展）。
- 图片路径媒体根目录白名单（默认用户主目录 + 仓库目录，可用 `PIXELFORGE_ALLOWED_ROOTS` 扩展）。
- 模型权重不随仓库分发。

### 工程
- pytest 测试、前端 `tsc` / Vite 构建、MCP 端到端检查脚本。
- 移除未使用的 `scipy` 依赖；统一版本号；可移植启动脚本。
