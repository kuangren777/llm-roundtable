# Multi-LLM Debate (Docker)

本仓库包含：
- `backend/`: FastAPI + SQLite
- `frontend-new/`: React + Vite（生产由 Nginx 托管，并反向代理 `/api`）

## 1. 前置要求

- Docker
- Docker Compose（`docker compose` 或 `docker-compose`）

## 2. 一键启动（推荐）

```bash
docker compose up -d --build
# 如果你的环境只有旧命令：
# docker-compose up -d --build
```

启动后：
- 前端: `http://localhost:3000`
- 后端 API: `http://localhost:8000`
- 健康检查: `http://localhost:8000/api/health`

停止：

```bash
docker compose down
# 或 docker-compose down
```

停止并删除数据卷（会清空对话数据）：

```bash
docker compose down -v
# 或 docker-compose down -v
```

## 3. 镜像与服务说明

### backend

- Dockerfile: `backend/Dockerfile`
- 启动命令: `uvicorn backend.app.main:app --host 0.0.0.0 --port 8000`
- 数据库路径（容器内）: `/data/debate.db`
- 上传目录（容器内）: `/app/backend/uploads`

### frontend

- Dockerfile: `frontend-new/Dockerfile`
- Nginx 配置: `frontend-new/nginx.conf`
- 将 `/api/*` 代理到 `backend:8000`
- 对 `/chat/*`、`/share/*` 等前端路由做 SPA fallback（`index.html`）

## 4. 数据持久化

`docker-compose.yml` 使用了两个命名卷：

- `debate_data`: 持久化 SQLite 数据库
- `uploads_data`: 持久化上传文件

查看卷：

```bash
docker volume ls | grep -E 'debate_data|uploads_data'
```

## 5. 配置说明

Compose 默认注入了：

- `DATABASE_URL=sqlite+aiosqlite:////data/debate.db`
- `AUTH_COOKIE_SECURE=false`（本地 HTTP 场景）

并将宿主机 `./config` 挂载到容器 `/app/config`（只读）。  
如果你在 `config/.env` 里配置了模型 key，会被后端读取。

端口在 `docker-compose.yml` 里直接修改：

```yaml
services:
  backend:
    ports:
      - "8000:8000"
  frontend:
    ports:
      - "3000:80"
```

## 6. 日志与排查

查看所有日志：

```bash
docker compose logs -f
# 或 docker-compose logs -f
```

只看后端：

```bash
docker compose logs -f backend
# 或 docker-compose logs -f backend
```

只看前端：

```bash
docker compose logs -f frontend
# 或 docker-compose logs -f frontend
```

## 7. 单独构建（可选）

```bash
docker build -f backend/Dockerfile -t multi-llm-backend .
docker build -f frontend-new/Dockerfile -t multi-llm-frontend .
```
