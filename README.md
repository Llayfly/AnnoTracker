# 标注员工作统计监控系统 v2.0

柱状图版本，部署在 Vercel + Vercel Postgres。

## 部署步骤

### 1. 在 Vercel 创建 Postgres 数据库

1. 进入 Vercel 项目 → Storage 标签
2. 点击 Create Database → 选 Postgres
3. 创建后会自动注入 `POSTGRES_URL` 等环境变量

### 2. 配置环境变量

在 Vercel 项目 Settings → Environment Variables 中添加：

| 变量名 | 值 |
|--------|-----|
| `PLATFORM_BASE_URL` | `https://data-platform.synapath.com` |
| `PLATFORM_EMAIL` | `198176@qq.com` |
| `PLATFORM_PASSWORD` | `qaz123456` |
| `PLATFORM_ORGANIZATION` | `HC` |
| `BACKFILL_DAYS` | `30` |

### 3. 部署

推送代码到 GitHub，Vercel 自动部署。

### 4. 初始化数据

部署成功后，访问以下接口触发首次数据采集：

```
POST https://你的域名/api/backfill
```

## 架构

- 前端：静态 HTML/CSS/JS（柱状图）
- API：Vercel Serverless Functions
- 数据库：Vercel Postgres (PostgreSQL)
- 定时任务：Vercel Cron Jobs（每30分钟采集当天数据，每天凌晨补采前一天）

## API 列表

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 系统状态 |
| `/api/stats?range=1w` | GET | 统计数据 |
| `/api/stats/[label]?label=HC8` | GET | 标注员详情 |
| `/api/collect` | POST | 手动采集 |
| `/api/backfill` | POST | 回填历史数据 |
| `/api/logs` | GET | 采集日志 |
