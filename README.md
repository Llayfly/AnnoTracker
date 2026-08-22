# 标注员工作统计监控网站（新快照系统）

自动从数据标注平台 `data-platform.synapath.com` 采集标注员**单日**工作数据，从 **2026-08-23** 起每天 **23:59（北京时间）** 定时快照，逐日累加展示。与 2026-08-23 之前的旧数据完全分离。

## 为什么是「单日快照」？

平台的「区间累计」数据不稳定（今天截和过几天截的结果不一样），但**单日数据**（`day=YYYY-MM-DD`）可靠。因此本系统每天采集一次单日数据并保存，展示时按所选区间逐日累加：

- **原始时长 = 新任务之和**（区间内每天新任务时长累加）
- 旧任务、片段时长、无片段、PASS 占比、结算参考等列照常展示
- 支持**手动录入**（自己截图记录），自动采集与手动录入互不覆盖

## 功能特性

- **多时间范围查询**：最近1天 / 3天 / 1周 / 15天 / 1月，支持自定义起止日期（仅限 2026-08-23 之后）
- **标注员搜索**：按名称实时模糊搜索
- **分组展示**：按组织分组（HC / C / HBHC / S / JS / 其他），每组带蓝色柱状图（新任务时长降序）
- **汇总数据**：原始时长(=新任务之和)、旧任务、片段时长、PASS占比、结算参考、日均新任务
- **每日明细**：点击标注员查看逐日数据（含来源：自动/手动）
- **手动录入**：自己截图记录当天数据（原始时长自动 = 新任务）
- **CSV 导出**：一键导出当前查询结果
- **自动采集**：每天 23:59（北京时间）Vercel Cron 触发，采集最新可用单日数据
- **登录保护**：所有数据接口需 JWT 认证

## 技术栈

| 组件 | 技术 |
|------|------|
| 部署 | Vercel（Serverless Functions + Static） |
| 数据库 | Turso（libSQL，`@libsql/client`） |
| 定时任务 | Vercel Cron（`vercel.json`） |
| 前端 | 原生 HTML / CSS / JS |
| 认证 | JWT（`jsonwebtoken`） |

## 项目结构

```
annotator-monitor/
├── api/
│   ├── login.js            # 登录（签发 JWT）
│   ├── snapshot.js         # 新快照系统一体化接口（汇总/明细/导出/手动录入）
│   ├── collect.js          # 手动触发采集（可指定日期范围重采）
│   ├── cron.js             # 定时采集端点（Vercel Cron 调用）
│   ├── status.js           # 系统状态
│   ├── batches.js          # 批次管理
│   ├── collect-batches.js  # 批次自动采集
│   ├── salary.js           # 薪资计算
│   └── health.js           # 健康检查
├── lib/
│   ├── db.js               # Turso 建表 + 快照读写 + 手动录入
│   ├── collector.js        # 平台登录 + 单日快照采集 + 批次采集
│   └── auth.js             # JWT 认证中间件
├── public/
│   ├── index.html          # 统计监控主页面
│   ├── app.js              # 前端交互逻辑
│   ├── login.html          # 登录页
│   ├── batches.html/js     # 批次管理
│   ├── salary.html/js      # 薪资计算
│   └── style.css           # 样式
├── vercel.json             # Vercel 配置（region / cron / headers）
├── .env.example            # 环境变量模板
└── package.json
```

## 部署到 Vercel

1. 将代码推送到 GitHub 仓库，在 Vercel 导入该仓库。
2. 在 Vercel 项目设置中配置环境变量（见下表）。
3. 部署后访问 `https://<你的域名>`。

### 环境变量

| 变量 | 说明 |
|------|------|
| `TURSO_DATABASE_URL` | Turso 数据库连接地址（`libsql://...`） |
| `TURSO_AUTH_TOKEN` | Turso 数据库认证令牌 |
| `AM_PLATFORM_BASE_URL` | 数据标注平台地址 |
| `AM_PLATFORM_EMAIL` | 平台登录邮箱 |
| `AM_PLATFORM_PASSWORD` | 平台登录密码 |
| `AM_PLATFORM_ORGS` | 采集组织，逗号分隔（默认 `HC,C,S,JS`） |
| `AM_NO_CLIP_FACTOR` | 无片段等效系数（默认 `0.2`） |
| `AM_REQUEST_TIMEOUT_MS` | 平台请求超时（默认 `8000`） |
| `AM_AUTH_USERNAME` | 网站登录用户名 |
| `AM_AUTH_PASSWORD` | 网站登录密码 |
| `AM_JWT_SECRET` | JWT 签名密钥 |
| `CRON_SECRET` | 定时采集密钥（Vercel Cron 自动携带） |

> 注意：`vercel.json` 中 `regions` 需与 Turso 数据库同区域（如 Turso `nrt` → Vercel `hnd1`），否则查询延迟很高。

### 定时任务

| 频率 | 任务 |
|------|------|
| 每天 23:59（北京时间，即 15:59 UTC） | 采集最新可用单日快照 |

平台每天 00:23（北京时间）生成前一天数据，因此 23:59 采集时会自动回退采集前一天的数据（当天数据尚未生成）。

## API 接口

### `POST /api/login`
登录，返回 JWT token。参数：`{ username, password }`。

### `GET /api/snapshot?start=&end=&search=`
汇总数据（原始时长 = 新任务之和）。参数：`start`、`end`（YYYY-MM-DD，仅限 2026-08-23 之后）、`search`（可选）。

### `GET /api/snapshot?mode=detail&label=&start=&end=`
某标注员每日明细。

### `GET /api/snapshot?mode=export&start=&end=`
导出 CSV。

### `POST /api/snapshot?mode=manual`
手动录入/更新快照。参数：`{ label, date, newTaskHours, oldTaskHours, segmentHours, noClipHours, passSegmentHours }`。

### `DELETE /api/snapshot?mode=manual`
删除手动快照。参数：`{ label, date }`。

### `POST /api/collect`
手动触发采集。可选 body：`{ start, end }` 重新采集指定日期范围（最多7天）；不带参数则采集最新可用数据。

### `GET /api/cron`
定时采集端点（Vercel Cron 调用，通过 `CRON_SECRET` 验证）。

### `GET /api/status`
系统状态：标注员数量、快照日期范围、最近采集日志。

## 数据采集流程

```
每天 23:59 北京时间（Vercel Cron → /api/cron）
    ↓
登录平台 (POST /api/v1/annotator-auth/login)
    ↓ 获取 JWT token
并行请求各组织统计 API (GET /api/v1/analytics/annotation-analytics?day=YYYY-MM-DD)
    ↓ 按标注员去重（保留原始时长最大行）
计算：无片段等效 = 无片段 × 0.2；结算参考 = PASS片段 + 无片段等效
    ↓ 写入 daily_snapshots（source='auto'）
前端通过 /api/snapshot 查询，按区间逐日累加展示
```

手动录入写入 `daily_snapshots`（source='manual'），自动采集不会覆盖手动记录。

## 常见问题

### 数据为空
新系统从 2026-08-23 开始采集。平台每天 00:23 生成前一天数据，因此当天数据需次日才能采集到。可点击「手动录入」自己截图记录当天数据。

### 手动录入与自动采集冲突
手动录入的记录（source='manual'）优先，自动采集不会覆盖手动记录。如需修正，可在手动录入弹窗中删除该记录后重新录入。
