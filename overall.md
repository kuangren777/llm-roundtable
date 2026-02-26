# Multi-LLM 圆桌讨论平台 — 全面概览

## 1. 项目概述

多智能体圆桌讨论平台，实现"智能圆桌主持人模式"（Orchestrator-Workers-Critic 架构），多个 LLM 在结构化辩论中协作。

**技术栈：** FastAPI + LangGraph + LiteLLM（后端），React 18 + Vite（前端），SQLite + Alembic（数据库）

**运行方式：**
- 后端：`uvicorn backend.app.main:app --reload`（端口 8000）
- 前端：`cd frontend && npm run dev`（端口 3000，代理到 8000）
- 测试：`python -m pytest unit_test/ -v`（100+ 测试）
- 一键启停：`bash scripts/restart.sh [--backend-only | --frontend-only | --stop]`

---

## 2. 项目结构

```
multi_llm_debate/
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   ├── discussions.py          # 讨论 REST 端点 (CRUD + SSE)
│   │   │   ├── llm_providers.py        # LLM 供应商 CRUD
│   │   │   └── materials.py            # 素材库端点
│   │   ├── models/
│   │   │   └── models.py               # SQLAlchemy ORM 模型
│   │   ├── schemas/
│   │   │   └── schemas.py              # Pydantic V2 请求/响应模型
│   │   ├── services/
│   │   │   ├── discussion_engine.py    # LangGraph 工作流 (5 节点)
│   │   │   ├── discussion_service.py   # DB 编排 + 模式→代理解析 + SSE 流
│   │   │   ├── llm_service.py          # LiteLLM 封装 + 重试 + 流式
│   │   │   ├── mode_templates.py       # 预定义代理模板 + 轮询分配
│   │   │   └── planner.py              # 自动模式 LLM 规划器
│   │   ├── database.py                 # 异步 SQLAlchemy 引擎 + 会话工厂
│   │   ├── config.py                   # 配置 (database_url, host, port)
│   │   └── main.py                     # FastAPI 应用 + 路由注册 + SPA 服务
│   ├── alembic/
│   │   ├── env.py                      # 迁移环境配置
│   │   └── versions/                   # 7 个迁移文件
│   ├── alembic.ini
│   ├── requirements.txt
│   └── uploads/                        # 上传文件存储
│       ├── {discussion_id}/            # 讨论级素材
│       └── library/                    # 全局素材库
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                     # 主布局 (侧边栏 + 主面板)
│   │   ├── main.jsx                    # React 入口
│   │   ├── pages/
│   │   │   ├── CreatePage.jsx          # 两步创建流程
│   │   │   ├── DiscussionPage.jsx      # 实时讨论视图
│   │   │   └── SettingsPage.jsx        # LLM 供应商管理
│   │   ├── services/
│   │   │   └── api.js                  # API 客户端 (含 POST-SSE)
│   │   └── styles/
│   │       └── index.css               # 暗色主题 + 角色配色
│   ├── vite.config.js
│   └── package.json
│
├── unit_test/
│   ├── conftest.py                     # 共享 fixtures (内存 DB, 异步客户端)
│   ├── test_api.py                     # ~40 测试
│   ├── test_schemas.py                 # ~20 测试
│   ├── test_llm_service.py             # ~10 测试
│   ├── test_discussion_engine.py       # ~15 测试
│   └── test_mode_templates.py          # ~14 测试
│
├── config/.env                         # 环境变量
├── scripts/
│   ├── setup.sh                        # 一键安装
│   └── restart.sh                      # 启停脚本
├── debate.db                           # SQLite 数据库
├── CLAUDE.md                           # 项目进度追踪
└── pyproject.toml                      # pytest asyncio_mode=auto
```

---

## 3. 数据库模型

### 3.1 枚举类型

| 枚举 | 值 | 说明 |
|------|-----|------|
| **DiscussionStatus** | CREATED, PLANNING, DISCUSSING, REFLECTING, SYNTHESIZING, WAITING_INPUT, COMPLETED, FAILED | 讨论生命周期状态 |
| **DiscussionMode** | AUTO, DEBATE, BRAINSTORM, SEQUENTIAL, CUSTOM | 编排模式 |
| **AgentRole** | HOST, PANELIST, CRITIC, USER | 代理角色 |

### 3.2 数据表

#### `discussions` — 讨论主表

| 列名 | 类型 | 默认值 | 可空 | 说明 |
|------|------|--------|------|------|
| id | Integer | 自增 | NO | 主键 |
| topic | Text | — | NO | 讨论主题 |
| mode | Enum(DiscussionMode) | AUTO | NO | 编排模式 |
| status | Enum(DiscussionStatus) | CREATED | NO | 当前状态 |
| llm_configs | JSON | `[]` | NO | 创建时 LLM 配置快照 |
| current_round | Integer | 0 | YES | 当前轮次 |
| max_rounds | Integer | 3 | YES | 最大轮次 (1-10) |
| title | String(200) | NULL | YES | 自动生成的短标题 |
| final_summary | Text | NULL | YES | 最终综合总结 |
| created_at | DateTime | now(UTC) | YES | 创建时间 |
| updated_at | DateTime | now(UTC) | YES | 更新时间 |

关系：agents (1:N), messages (1:N), materials (1:N)，均级联删除

#### `agent_configs` — 代理配置

| 列名 | 类型 | 默认值 | 可空 | 说明 |
|------|------|--------|------|------|
| id | Integer | 自增 | NO | 主键 |
| discussion_id | Integer (FK) | — | NO | 外键→discussions |
| name | String(100) | — | NO | 代理名称 (如"主持人") |
| role | Enum(AgentRole) | — | NO | 角色 |
| persona | Text | NULL | YES | 人设描述 |
| provider | String(50) | "openai" | NO | LLM 供应商 |
| model | String(100) | "gpt-4o" | NO | 模型标识 |
| api_key | String(500) | NULL | YES | 可选覆盖 API Key |
| base_url | String(500) | NULL | YES | 可选覆盖 Base URL |

#### `llm_providers` — 全局 LLM 供应商

| 列名 | 类型 | 默认值 | 可空 | 说明 |
|------|------|--------|------|------|
| id | Integer | 自增 | NO | 主键 |
| name | String(100) | — | NO | 显示名称 |
| provider | String(50) | — | NO | 供应商类型 (openai/anthropic/gemini/deepseek/groq/ollama/vllm) |
| api_key | String(500) | NULL | YES | API 密钥（响应中隐藏，仅暴露 has_api_key） |
| base_url | String(500) | NULL | YES | 自定义 Base URL |
| created_at | DateTime | now(UTC) | YES | 创建时间 |
| updated_at | DateTime | now(UTC) | YES | 更新时间 |

关系：models (1:N)，级联删除

#### `llm_models` — 模型配置（多对一供应商）

| 列名 | 类型 | 默认值 | 可空 | 说明 |
|------|------|--------|------|------|
| id | Integer | 自增 | NO | 主键 |
| provider_id | Integer (FK) | — | NO | 外键→llm_providers |
| model | String(100) | — | NO | 模型标识 (如 gpt-4o) |
| name | String(100) | NULL | YES | 显示名称 |
| created_at | DateTime | now(UTC) | YES | 创建时间 |

#### `messages` — 讨论消息

| 列名 | 类型 | 默认值 | 可空 | 说明 |
|------|------|--------|------|------|
| id | Integer | 自增 | NO | 主键 |
| discussion_id | Integer (FK) | — | NO | 外键→discussions |
| agent_name | String(100) | — | NO | 发送者名称 |
| agent_role | Enum(AgentRole) | — | NO | 发送者角色 |
| content | Text | — | NO | 消息内容 |
| summary | Text | NULL | YES | LLM 生成的摘要 |
| round_number | Integer | 0 | YES | 轮次号 |
| phase | String(50) | NULL | YES | 讨论阶段 |
| created_at | DateTime | now(UTC) | YES | 创建时间 |

#### `discussion_materials` — 素材（文件/文本）

| 列名 | 类型 | 默认值 | 可空 | 说明 |
|------|------|--------|------|------|
| id | Integer | 自增 | NO | 主键 |
| discussion_id | Integer (FK) | NULL | YES | 外键→discussions；NULL = 素材库项 |
| filename | String(255) | — | NO | 文件名 |
| filepath | String(500) | — | NO | 磁盘路径 |
| file_type | String(20) | — | NO | "file" 或 "image" |
| mime_type | String(100) | NULL | YES | MIME 类型 |
| file_size | Integer | NULL | YES | 文件大小(字节) |
| text_content | Text | NULL | YES | 文本内容 |
| status | String(20) | "ready" | NO | "processing" / "ready" / "failed" |
| meta_info | JSON | NULL | YES | LLM 生成的元数据 {summary, keywords, type} |
| created_at | DateTime | now(UTC) | YES | 创建时间 |

#### `system_settings` — 系统设置（KV 存储）

| 列名 | 类型 | 默认值 | 可空 | 说明 |
|------|------|--------|------|------|
| key | String(100) | — | NO | 主键 |
| value | Text | NULL | YES | JSON 编码的值 |
| updated_at | DateTime | now(UTC) | YES | 更新时间 |

### 3.3 Alembic 迁移历史

| 版本 | 名称 | 内容 |
|------|------|------|
| 8991597c1c94 | initial_schema | 创建 discussions, agent_configs, messages 表 |
| b2a3c4d5e6f7 | add_mode_and_llm_configs | 添加 mode 枚举 + llm_configs JSON |
| c3d4e5f6a7b8 | add_title_to_discussions | 添加 title 字段 |
| d4e5f6a7b8c9 | add_discussion_materials | 创建 discussion_materials 表 |
| e5f6a7b8c9d0 | add_message_summary_and_settings | 添加 summary 字段 + system_settings 表 |
| f6a7b8c9d0e1 | material_library | discussion_id 改为可空（素材库） |
| g7b8c9d0e1f2 | material_status_metadata | 添加 status + meta_info 字段 |

---

## 4. API 接口（共 35 个端点）

### 4.1 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 返回 `{"status": "ok"}` |

### 4.2 讨论管理 (`/api/discussions`) — 20 个端点

#### CRUD

| 方法 | 路径 | 请求体 | 响应 | 说明 |
|------|------|--------|------|------|
| POST | `/api/discussions/` | `{topic, mode, max_rounds, agents?, selected_model_ids?, host_model_id?}` | DiscussionResponse | 创建讨论，快照全局 LLM 配置 |
| GET | `/api/discussions/` | — | list[DiscussionResponse] | 列出所有讨论（按创建时间倒序） |
| GET | `/api/discussions/{id}` | — | DiscussionDetail (含 agents, messages, materials) | 获取讨论详情 |
| DELETE | `/api/discussions/{id}` | — | 204 | 级联删除代理/消息/素材 + 清理磁盘文件 |

#### 代理管理

| 方法 | 路径 | 请求体 | 响应 | 说明 |
|------|------|--------|------|------|
| PUT | `/api/discussions/{id}/agents/{agent_id}` | `{name?, persona?, provider?, model?}` | AgentConfigResponse | 更新代理配置 |
| POST | `/api/discussions/{id}/prepare-agents` | — | list[AgentConfigResponse] | 预生成代理（运行前预览/编辑） |
| POST | `/api/discussions/{id}/generate-title` | — | `{"title": str}` | LLM 生成短标题（≤10 中文字） |

#### 讨论执行（SSE 流式）

| 方法 | 路径 | 响应类型 | 说明 |
|------|------|----------|------|
| POST | `/api/discussions/{id}/run` | text/event-stream | 运行 LangGraph 工作流，流式推送事件 |
| POST | `/api/discussions/{id}/stop` | JSON | 取消运行中的讨论 |
| POST | `/api/discussions/{id}/complete` | JSON | 手动标记讨论完成 |

**SSE 事件类型 (`/run`)：**
- `phase_change` — 阶段切换 (planning→discussing→reflecting→synthesizing)
- `message` — 代理消息
- `llm_progress` — LLM 流式进度 (chars_received, llm_status)
- `user_message_consumed` — 用户消息被消费
- `complete` / `cycle_complete` — 完成/轮次完成
- `error` — 错误

#### 用户输入

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| POST | `/api/discussions/{id}/user-input` | `{content}` | 提交用户消息（非阻塞注入下一轮） |
| DELETE | `/api/discussions/{id}/messages/{msg_id}` | — | 删除用户消息 |
| PUT | `/api/discussions/{id}/messages/{msg_id}` | `{content}` | 编辑用户消息 |

#### 自动摘要（SSE 流式）

| 方法 | 路径 | 响应类型 | 说明 |
|------|------|----------|------|
| POST | `/api/discussions/{id}/summarize` | text/event-stream | 批量摘要未总结的长消息 |

**SSE 事件类型 (`/summarize`)：**
- `summary_progress` — 摘要进度
- `summary_done` — 单条消息摘要完成 (message_id, summary)
- `summary_complete` — 全部完成

#### 讨论素材

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| POST | `/api/discussions/{id}/materials` | multipart/form-data (files) | 上传文件到讨论 + 自动创建素材库副本 |
| GET | `/api/discussions/{id}/materials` | — | 列出讨论素材 |
| DELETE | `/api/discussions/{id}/materials/{mat_id}` | — | 删除讨论素材 |
| POST | `/api/discussions/{id}/attach-materials` | `{material_ids: [int]}` | 从素材库附加到讨论 |

### 4.3 素材库 (`/api/materials`) — 4 个端点

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| GET | `/api/materials/` | — | 列出全局素材库（discussion_id=NULL） |
| POST | `/api/materials/paste` | `{content}` | 粘贴文本→立即返回 status="processing"，后台 LLM 生成文件名+元数据 |
| POST | `/api/materials/upload` | multipart/form-data | 上传文件到素材库 |
| DELETE | `/api/materials/{id}` | — | 删除素材库项 |

### 4.4 LLM 供应商 (`/api/llm-providers`) — 7 个端点

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| GET | `/api/llm-providers/` | — | 列出所有供应商（含嵌套模型，API Key 隐藏） |
| POST | `/api/llm-providers/` | `{name, provider, api_key?, base_url?}` | 创建供应商 |
| PUT | `/api/llm-providers/{id}` | `{name?, provider?, api_key?, base_url?}` | 更新供应商 |
| DELETE | `/api/llm-providers/{id}` | — | 删除供应商（级联删除模型） |
| POST | `/api/llm-providers/{id}/models` | `{model, name?}` | 添加模型 |
| PUT | `/api/llm-providers/{id}/models/{model_id}` | `{model?, name?}` | 更新模型 |
| DELETE | `/api/llm-providers/{id}/models/{model_id}` | — | 删除模型 |

### 4.5 系统设置 (`/api/settings`) — 2 个端点

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| GET | `/api/settings/{key}` | — | 获取设置值 |
| PUT | `/api/settings/{key}` | `{value: any}` | 创建/更新设置（JSON 编码） |

### 4.6 中间件与配置

- **CORS：** 允许所有来源、方法、头部
- **SPA 服务：** 当 `backend/static/` 存在时，提供构建后的前端 + index.html 回退
- **生命周期：** 启动时通过 `init_db()` 初始化数据库

---

## 5. 后端服务层

### 5.1 LLM 服务 (`llm_service.py`)

统一的 OpenAI 兼容 API 封装，支持多供应商 LLM 调用。

| 函数 | 说明 |
|------|------|
| `_normalize_base_url(url)` | 自动为裸域名追加 `/v1`（修复 OneAPI/New API HTML 响应问题） |
| `call_llm(provider, model, messages, api_key, base_url, temperature, timeout, **kwargs)` | 非流式 LLM 调用，指数退避重试（7 次，1s→64s） |
| `call_llm_stream(provider, model, messages, api_key, base_url, temperature, on_chunk, timeout)` | 流式 LLM 调用，异步 `on_chunk` 回调，返回 (full_text, total_chars) |

关键模式：
- 重试逻辑：MAX_RETRIES=7, BASE_DELAY=1.0s, 指数退避 (2^attempt)
- HTML 检测：捕获配置错误端点返回的 HTML 响应
- 供应商无关：兼容任何 OpenAI 兼容 API

### 5.2 讨论服务 (`discussion_service.py`)

核心编排服务，管理 DB 操作、讨论生命周期、素材管理和 SSE 流。

#### 讨论 CRUD

| 函数 | 说明 |
|------|------|
| `create_discussion(db, data)` | 创建讨论，快照全局 LLM 配置到 llm_configs JSON |
| `get_discussion(db, id)` | 获取讨论（eager load agents/messages/materials） |
| `list_discussions(db)` | 列出所有讨论（按创建时间倒序） |
| `delete_discussion(db, id)` | 删除讨论 + 级联删除 + 清理磁盘文件 |
| `update_agent(db, discussion_id, agent_id, data)` | 更新代理配置，自动从 LLMProvider 表解析 api_key/base_url |
| `prepare_agents(db, id)` | 预生成代理（模板或规划器），启用运行前预览/编辑 |
| `generate_title(db, id)` | LLM 生成短标题（≤10 中文字） |

#### 讨论执行

| 函数 | 说明 |
|------|------|
| `run_discussion(db, id)` | 主 SSE 流端点：运行 LangGraph 引擎，通过 asyncio.Queue 推送事件 |
| `stop_discussion(db, id)` | 取消运行：kill graph task + drain task，重置状态 |
| `complete_discussion(db, id)` | 手动标记完成 |
| `submit_user_input(db, id, content)` | 保存用户消息到 DB + 队列注入下一轮 host_planning_node |
| `delete_user_message(db, id, msg_id)` | 删除用户消息 |
| `update_user_message(db, id, msg_id, content)` | 编辑用户消息 |

#### 素材管理

| 函数 | 说明 |
|------|------|
| `upload_materials(db, id, files)` | 保存文件到磁盘 + DB，自动创建素材库副本 |
| `list_materials(db, id)` / `delete_material(db, id, mat_id)` | 讨论级素材 CRUD |
| `upload_to_library(db, files)` | 上传文件到全局素材库 |
| `list_library_materials(db)` / `delete_library_material(db, id)` | 素材库 CRUD |
| `attach_library_materials(db, id, material_ids)` | 从素材库复制到讨论 |
| `save_text_material(db, text, filename_override?)` | 粘贴文本→立即返回 status="processing"，后台生成文件名+元数据 |
| `generate_material_filename(text)` | LLM 生成中文短文件名 (5-10 字) |
| `generate_material_metadata(text)` | LLM 生成元数据 JSON {summary, keywords, type} |
| `_process_material_bg(material_id, text)` | 后台任务：生成文件名+元数据，重命名文件，更新 DB |

#### 自动摘要

| 函数 | 说明 |
|------|------|
| `summarize_discussion_messages(db, id)` | 批量摘要未总结的长消息（≥200 字），SSE 流式进度 |
| `_get_summary_model_config()` | 从 SystemSetting 读取摘要模型配置 |

#### 关键架构模式

1. **Queue-based SSE：** Graph 在后台 task 运行，推送事件到 `asyncio.Queue`，主协程读取并 yield SSE 事件。客户端断开时 spawn drain task 继续保存消息。
2. **非阻塞用户输入：** 模块级 `_pending_user_messages` 字典（按 discussion_id 索引），`host_planning_node` 在每轮开始时消费。
3. **后台任务：** `asyncio.create_task()` 用于摘要和素材处理——非阻塞、fire-and-forget。
4. **素材库：** `discussion_id` 可空——NULL = 素材库项（讨论删除后保留），int = 讨论级素材。

### 5.3 讨论引擎 (`discussion_engine.py`)

基于 LangGraph 的多代理讨论工作流。

#### 工作流状态 (`DiscussionState`)

```python
{
    "topic": str,              # 讨论主题
    "agents": list[AgentInfo], # 代理列表
    "messages": list[dict],    # 累积消息
    "current_round": int,      # 当前轮次
    "max_rounds": int,         # 最大轮次
    "host_plan": str,          # 主持人计划
    "critic_feedback": str,    # 批评家反馈
    "should_continue": bool,   # 是否继续
    "final_summary": str,      # 最终总结
    "materials": str,          # 格式化参考素材
    "phase": str,              # 当前阶段
    "discussion_id": int,      # 讨论 ID
    "single_round_mode": bool, # 恢复模式（仅一轮）
}
```

#### 5 个图节点

```
host_planning → panelist_discussion → critic_review ─┬─ continue → increment_round → host_planning
                                                      ├─ synthesize → synthesis → END
                                                      └─ stop → END
```

| 节点 | 说明 |
|------|------|
| `host_planning_node` | 分析主题，创建讨论计划；后续轮次处理批评家反馈；消费待处理用户消息 |
| `panelist_discussion_node` | 所有专家并行响应主持人计划（`asyncio.gather()`） |
| `critic_node` | 评估讨论，识别差距/矛盾 |
| `increment_round` | 递增轮次计数器 |
| `synthesis_node` | 主持人创建最终综合报告 |

条件逻辑 (`should_continue_or_synthesize`)：纯轮次计数——`current_round ≥ max_rounds-1` 则综合，`single_round_mode` 则停止，否则继续。

关键模式：
- **流式进度：** `_call_with_progress()` 封装 LLM 调用，通过 `ContextVar` 推送进度事件（每 5 个 chunk 节流）
- **用户消息注入：** `host_planning_node` 消费 `_pending_user_messages[discussion_id]`
- **素材注入：** 所有 4 个提示节点在主题后注入格式化素材文本
- **并行专家：** `asyncio.gather()` 并发执行专家响应

### 5.4 模式模板 (`mode_templates.py`)

预定义代理模板 + 轮询 LLM 分配。

| 模式 | 代理组成 |
|------|----------|
| DEBATE | 主持人 + 2 专家（正方/反方）+ 批评家 |
| BRAINSTORM | 主持人 + 3 专家（跨领域/UX/技术）+ 批评家 |
| SEQUENTIAL | 主持人 + 3 专家（顺序审查）+ 批评家 |

`assign_llms_to_agents(agent_defs, llm_configs)`：轮询分配——5 个代理 + 2 个 LLM → [0,1,0,1,0]

### 5.5 规划器 (`planner.py`)

AUTO 模式 LLM 规划器——根据主题生成最优代理面板。

| 函数 | 说明 |
|------|------|
| `plan_agents(topic, provider, model, api_key, base_url)` | 调用 LLM 生成代理面板，失败回退到默认面板 |
| `_parse_planner_response(response)` | 解析 JSON，去除 markdown 代码围栏，验证（≥1 host + ≥1 panelist） |
| `_default_panel()` | 回退面板：主持人 + 2 专家 + 批评家 |

---

## 6. 前端功能

### 6.1 主布局 (`App.jsx`)

聊天风格布局：可折叠侧边栏 + 主内容面板。

- 侧边栏显示讨论历史（状态徽章 + 模式标签）
- 三个视图：创建页 / 讨论页 / 设置页
- 使用 `display:none` 保持组件挂载（切换时保留状态）
- 新讨论创建后自动生成短标题

### 6.2 创建页 (`CreatePage.jsx`)

两步创建流程：

**第一步：主题 + 素材**
- 主题输入框（必填）
- 三个素材标签页：上传文件 | 粘贴文本 | 素材库
- 拖拽上传 + 图片缩略图预览
- 粘贴文本→LLM 异步生成文件名，保存到素材库
- 素材库搜索 + 复选框选择
- 处理中素材每 2s 轮询刷新
- 鼠标悬停显示元数据 tooltip（摘要/关键词/类型）

**第二步：配置弹窗**
- 模式选择器（自动/辩论/头脑风暴/顺序/自定义）
- 最大轮次滑块 (1-10)
- 非自定义模式：模型复选框列表 + 主持人模型下拉
- 自定义模式：代理配置面板（名称/人设/供应商/模型/角色）

文件验证：`.txt, .md, .pdf, .docx`（文档）+ `.png, .jpg, .jpeg, .gif, .webp`（图片），单文件 ≤10MB

### 6.3 讨论页 (`DiscussionPage.jsx`)

实时讨论视图，功能最丰富的页面。

**核心功能：**

1. **初始化：** 加载讨论 + 供应商；状态为 created 时调用 `prepareAgents()` 预生成代理
2. **SSE 流式讨论：** POST-based SSE (fetch + ReadableStream)，处理 phase_change/message/llm_progress/complete 等事件
3. **实时 LLM 进度：** 每个代理的字符计数实时更新，完成后 800ms 自动清除
4. **代理编辑：** 点击代理标签打开弹窗，编辑名称/人设/供应商/模型
5. **用户输入：** 底部持久输入栏，Ctrl+Enter 发送，乐观更新（立即显示）
6. **消息展示：** 角色配色 + 图标（🎯主持人/💡专家/🔍批评家/👤用户），长消息折叠/展开，复制按钮
7. **消息编辑/删除：** 用户消息支持编辑（Ctrl+Enter 保存）和删除（确认对话框）
8. **自动摘要：** 讨论完成后自动触发，流式进度显示，摘要到达后更新消息
9. **轮询回退：** 页面刷新时每 2.5s 轮询，终态时停止
10. **智能滚动：** 仅在用户接近底部（<120px）时自动滚动

**子组件：**
- `StreamingStatus` — 紧凑进度显示（SSE 模式：每代理进度；轮询模式：阶段状态）
- `AgentEditCard` — 代理配置卡片（脏标记 + 保存按钮）
- `CopyButton` — 剪贴板工具（HTTPS 用 navigator.clipboard，HTTP 回退 execCommand）
- `MessageBubble` — 消息气泡（角色样式/折叠/编辑/删除/摘要）

### 6.4 设置页 (`SettingsPage.jsx`)

全局 LLM 供应商 + 模型管理。

- **摘要模型选择器：** 下拉选择用于自动摘要的模型
- **添加供应商：** 快速预设（OpenAI/Anthropic/Gemini/DeepSeek/Groq/Ollama）或手动输入
- **供应商列表：** 内联编辑名称/供应商/api_key/base_url，Key 状态徽章
- **模型管理：** 每个供应商下嵌套模型列表，支持添加/编辑/删除

预设供应商及默认模型：
- OpenAI: gpt-4o, gpt-4o-mini
- Anthropic: claude-sonnet-4-5, claude-haiku-4-5
- Gemini: gemini-2.0-flash, gemini-2.5-pro-preview
- DeepSeek: deepseek-chat, deepseek-reasoner
- Groq: llama-3.3-70b-versatile
- Ollama: llama3

### 6.5 API 客户端 (`api.js`)

约 60 个 API 函数，分为：
- 讨论 CRUD (create/list/get/delete/stop/complete)
- 代理管理 (update/prepare/generateTitle)
- 用户输入 (submit/delete/update message)
- 素材管理 (upload/list/delete/attach — 讨论级 + 素材库级)
- LLM 供应商 (provider CRUD + model CRUD)
- 系统设置 (get/set)
- SSE 流式 (streamDiscussion, streamSummarize)

SSE 实现模式：`fetch()` + `ReadableStream` + `AbortController`（POST 方法，非 EventSource）

### 6.6 样式系统 (`index.css`)

暗色主题设计系统：
- 背景：`#0f1117` / `#1a1d27`
- 主色：`#6366f1`（靛蓝）
- 角色配色：主持人蓝 `#3b82f6` / 专家紫 `#8b5cf6` / 批评家琥珀 `#f59e0b`
- 侧边栏：280px（可折叠至 48px）
- 圆角：8px / 12px

---

## 7. 依赖

### 后端

| 包 | 版本 | 用途 |
|---|------|------|
| fastapi | 0.115.6 | Web 框架 |
| uvicorn | 0.34.0 | ASGI 服务器 |
| sqlalchemy | 2.0.36 | 异步 ORM |
| alembic | 1.14.1 | 数据库迁移 |
| pydantic | 2.10.4 | 数据验证 (V2) |
| pydantic-settings | 2.7.1 | 配置管理 (V2) |
| langgraph | 0.2.60 | 讨论工作流图 |
| langchain-core | 0.3.28 | LangChain 基础类 |
| litellm | 1.55.10 | 多供应商 LLM 抽象 |
| openai | >=2.0.0 | OpenAI SDK |
| httpx | >=0.23.0,<0.28.0 | HTTP 客户端（litellm 兼容性约束） |
| aiosqlite | 0.20.0 | 异步 SQLite 驱动 |

### 前端

| 包 | 版本 | 用途 |
|---|------|------|
| react | ^18.3.1 | UI 框架 |
| react-dom | ^18.3.1 | DOM 渲染 |
| vite | ^6.0.3 | 构建工具 + 开发服务器 |

---

## 8. 测试覆盖

共 100+ 测试，运行命令：`python -m pytest unit_test/ -v`

| 测试文件 | 数量 | 覆盖范围 |
|----------|------|----------|
| test_api.py | ~40 | REST 端点 (CRUD, SSE, LLM 供应商, 素材, 用户输入) |
| test_schemas.py | ~20 | Pydantic 验证 (AgentConfig, Discussion, LLMProvider, LLMModel) |
| test_llm_service.py | ~10 | LLM 调用, base_url 规范化, 供应商路由 |
| test_discussion_engine.py | ~15 | 图辅助函数, 代理查找, 轮次计数, 多轮逻辑 |
| test_mode_templates.py | ~14 | 模式模板, 轮询分配, 规划器解析 |

测试模式：
- 内存 SQLite DB + 异步 HTTP 客户端 (httpx AsyncClient + ASGITransport)
- `asyncio_mode = "auto"` 免去 `@pytest.mark.asyncio`
- unittest.mock / AsyncMock 模拟 LLM 调用

---

## 9. 核心用户工作流

### 创建讨论
1. 输入主题 → 可选上传文件/粘贴文本/选择素材库
2. 点击"下一步" → 配置弹窗（模式/轮次/模型）
3. 点击"开始讨论" → 创建讨论 + 上传素材 + 自动生成标题 → 跳转讨论页

### 运行讨论
1. 讨论页加载，预生成代理（可编辑）
2. 点击"开始讨论" → SSE 流开始
3. 实时事件流入：阶段切换 → 代理消息 → LLM 进度（字符计数）
4. 用户可随时发送输入（Ctrl+Enter）
5. 讨论完成或进入等待输入状态
6. 自动触发长消息摘要

### 管理 LLM 供应商
1. 设置页 → 添加供应商（预设或手动）
2. 预设自动添加常用模型
3. 可编辑/删除供应商和模型
4. 选择摘要模型
5. 全局持久化

---

## 10. 架构亮点

| 特性 | 实现方式 |
|------|----------|
| 异步优先 | 所有 DB/LLM/IO 操作均为 async |
| Queue-based SSE | Graph 后台运行 → asyncio.Queue → SSE yield |
| ContextVar 进度 | 不污染 TypedDict 状态即可传递 Queue |
| 非阻塞用户输入 | 模块级 pending dict + host_planning_node 消费 |
| 素材库 | nullable discussion_id 实现全局复用 |
| 后台任务 | asyncio.create_task() 用于摘要和素材处理 |
| 指数退避重试 | 7 次重试，1s→64s |
| 供应商无关 | LiteLLM 抽象，兼容任何 OpenAI 兼容 API |
| 配置快照 | 创建时快照 LLM 配置，解耦全局变更 |
| 智能滚动 | 仅在用户接近底部时自动滚动 |
| POST-based SSE | fetch + ReadableStream（EventSource 仅支持 GET） |
| 乐观更新 | 用户消息立即显示，不等 API 确认 |
