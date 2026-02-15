# 多智能体圆桌讨论平台 — 项目目标

## 核心理念
智能圆桌会议主持人模式 (The Intelligent Round Table Host Pattern)
— Orchestrator-Workers-Critic 架构，多个 LLM 协作进行有组织、有深度的虚拟研讨会。

## 技术栈
- **后端:** FastAPI + LangGraph + LiteLLM
- **前端:** React 18 + Vite
- **数据库:** SQLite (via SQLAlchemy + Alembic)，支持未来切换 MySQL/PostgreSQL
- **LLM:** LiteLLM 统一多供应商 (OpenAI, Anthropic, Gemini, DeepSeek, Groq, Ollama, vLLM 等)

## 简化用户流程 (Simplified UX)

用户只需提供三样东西：
1. **话题/问题** — 一段文字描述
2. **LLM 供应商列表** — 添加/删除自定义 LLM (供应商、模型名、API Key、Base URL)
3. **编排模式** — 从下拉菜单选择

### 编排模式

| 模式 | 说明 | 自动生成的角色 |
|------|------|---------------|
| **自动 (Auto)** | 默认推荐。用规划 LLM 分析话题，动态生成最优专家组合 | 由 LLM 规划决定 |
| **辩论 (Debate)** | 正方 vs 反方 + 主持人 | 主持人、正方辩手、反方辩手 |
| **头脑风暴 (Brainstorm)** | 多角度创意发散 + 批评家收敛 | 主持人、创意专家×N、批评家 |
| **顺序评审 (Sequential)** | 逐一审查，后者基于前者改进 | 主持人、评审员×N |
| **自定义 (Custom)** | 高级模式，手动定义每个 Agent | 用户自定义 |

### 自动模式工作流
1. 用户提交话题 + LLM 列表 + 选择"自动"
2. 后端用第一个 LLM 作为规划器，分析话题，输出 JSON 格式的专家角色列表
3. 将用户提供的 LLM 循环分配给各专家
4. 动态构建 LangGraph (supervisor + agent nodes)
5. 执行讨论，实时 SSE 流式返回

### 非自定义模式
- 后端根据模式模板自动生成 Agent 角色和人设
- 将用户的 LLM 列表循环分配给 Agent
- 用户无需手动配置任何 Agent

## 后端架构

### API 端点
- `POST /api/discussions/` — 创建讨论 (topic + llm_configs + mode)
- `GET /api/discussions/` — 列表
- `GET /api/discussions/{id}` — 详情
- `DELETE /api/discussions/{id}` — 删除
- `POST /api/discussions/{id}/run` — 运行讨论 (SSE 流)

### 数据模型
- **Discussion:** topic, mode, max_rounds, status, llm_configs (JSON), final_summary
- **AgentConfig:** discussion_id, name, role, persona, provider, model (自动生成)
- **Message:** discussion_id, agent_name, agent_role, content, round_number, phase

### 核心服务
- **mode_templates.py** — 各模式的预定义 Agent 模板
- **planner.py** — Auto 模式的 LLM 规划器
- **discussion_engine.py** — 动态 LangGraph 构建器 (supervisor + variable agent nodes)
- **llm_service.py** — LiteLLM 封装

## 前端设计

### 创建页面 (简化)
- 话题输入框
- LLM 供应商列表 (添加/删除，每项: 供应商、模型、API Key、Base URL)
- 模式下拉选择 (默认: 自动)
- "高级" 折叠面板 → 自定义模式 (手动定义 Agent)
- 开始按钮

### 讨论页面
- 实时消息流 (SSE)
- 阶段指示器 (规划中/讨论中/反思中/总结中)
- 角色标签 (颜色区分)
- 最终总结展示

### 首页
- 讨论列表 + 状态 + 删除
