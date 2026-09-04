# 标注员工作统计监控系统

自动从 data-platform.synapath.com 采集标注员工作数据，提供可视化统计 dashboard，支持时间范围筛选、标注员搜索、颜色预警。

## 功能特性

- **多时间范围查看**：最近1天、3天、1周、15天、1个月，支持自定义日期范围
- **标注员搜索**：按标注员标签或名称搜索
- **颜色预警**：
  - 🔴 红色预警：日均不足3小时
  - 🔵 蓝色正常：日均3-5小时
  - 🟢 绿色活跃：日均超过5小时
- **统计字段**：原始时长、片段时长、无片段时长、无片段等效、结算参考、累计参考
- **自动更新**：每30分钟自动采集最新数据，新员工自动同步
- **详情查看**：点击标注员查看每日明细
- **数据导出**：支持导出CSV
- **公开访问**：部署后任何人可通过网址访问

## 系统架构

```
数据平台 API ──→ 数据采集器(定时) ──→ SQLite 数据库
                                        ↓
                              Express API 服务器
                                        ↓
                              前端 Dashboard (HTML/CSS/JS)
                                        ↓
                              Nginx 反向代理 → 公网访问
```

## 环境要求

- Node.js 16+
- npm 或 yarn
- Nginx（用于反向代理）
- PM2（用于进程管理，可选）

## 快速部署

### 1. 上传项目到服务器

```bash
# 将项目上传到服务器，例如 /opt/annotator-stats
scp -r annotator-stats/ user@your-server:/opt/
```

### 2. 安装依赖

```bash
cd /opt/annotator-stats
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，设置平台账号密码和服务器配置
vi .env
```

关键配置项：
```
PLATFORM_EMAIL=198176@qq.com      # 平台登录邮箱
PLATFORM_PASSWORD=qwe123           # 平台登录密码
PLATFORM_ORGANIZATION=HC           # 组织名称
PORT=3000                          # 服务端口
COLLECT_INTERVAL_MINUTES=30        # 采集间隔（分钟）
BACKFILL_DAYS=30                   # 首次启动回填天数
```

### 4. 启动服务

**方式一：直接运行（测试用）**
```bash
node src/server.js
```

**方式二：使用 PM2（推荐，生产环境）**
```bash
# 安装 PM2
npm install -g pm2

# 修改 ecosystem.config.js 中的 cwd 路径
vi ecosystem.config.js
# 将 cwd 改为实际路径，如 /opt/annotator-stats

# 启动
pm2 start ecosystem.config.js

# 设置开机自启
pm2 save
pm2 startup
```

### 5. 配置 Nginx 反向代理

```bash
# 复制配置文件
sudo cp nginx.conf /etc/nginx/sites-available/annotator-stats

# 修改域名
sudo vi /etc/nginx/sites-available/annotator-stats
# 将 your-domain.com 改为您的实际域名

# 创建软链接
sudo ln -s /etc/nginx/sites-available/annotator-stats /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载 Nginx
sudo systemctl reload nginx
```

### 6. 配置 SSL（HTTPS，推荐）

```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# 申请 SSL 证书
sudo certbot --nginx -d your-domain.com

# 自动续期已配置，无需手动操作
```

## 使用说明

### 访问系统

部署完成后，通过浏览器访问 `http://your-domain.com` 或 `https://your-domain.com`

### 界面操作

1. **时间范围**：点击顶部按钮切换（1天/3天/1周/15天/1月）
2. **自定义日期**：使用日期选择器选择起止日期
3. **搜索标注员**：在搜索框输入标注员标签
4. **查看详情**：点击标注员行的"详情"按钮查看每日明细
5. **手动刷新**：点击右上角"刷新"按钮立即采集最新数据
6. **导出数据**：点击"导出CSV"按钮下载当前表格数据
7. **排序**：点击表头可按该列排序

### API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 系统状态 |
| `/api/annotators` | GET | 所有标注员列表 |
| `/api/stats?range=1w` | GET | 统计数据（range: 1d/3d/1w/15d/1m） |
| `/api/stats?startDate=X&endDate=Y` | GET | 自定义日期范围统计 |
| `/api/stats/:label` | GET | 单个标注员详细数据 |
| `/api/org-cumulative` | GET | 组织累计数据 |
| `/api/dates` | GET | 可用日期列表 |
| `/api/logs` | GET | 采集日志 |
| `/api/collect` | POST | 手动触发采集 |
| `/api/backfill` | POST | 手动触发回填 |

## 运维命令

```bash
# 查看服务状态
pm2 status annotator-stats

# 查看日志
pm2 logs annotator-stats

# 重启服务
pm2 restart annotator-stats

# 停止服务
pm2 stop annotator-stats

# 手动回填历史数据（30天）
node src/backfill.js 30

# 手动采集指定日期
node src/collect-now.js 2026-08-01
```

## 数据说明

### 统计字段

| 字段 | 说明 | 数据来源 |
|------|------|----------|
| 原始时长 | 标注员处理的视频总时长 | daily_rows.raw_video_duration_seconds |
| 片段时长 | 标注的片段总时长 | daily_rows.segment_duration_seconds |
| 无片段时长 | 无标注片段的时长 | daily_rows.no_clip_duration_seconds |
| 无片段等效 | 无片段时长 × 0.2 | 计算值 |
| 结算参考 | 片段时长 + 无片段等效 | settlement_rows（需终审通过） |
| 累计参考 | 累计结算参考 | settlement_rows（需终审通过） |

### 数据更新机制

- 每30分钟自动采集当天最新数据
- 每天凌晨00:05补采前一天的最终数据
- 首次启动自动回填最近30天历史数据
- 新加入的标注员会在下次采集时自动同步

## 故障排查

### 服务无法启动

```bash
# 检查日志
pm2 logs annotator-stats --lines 50

# 检查端口占用
lsof -i :3000

# 检查 Node.js 版本
node -v  # 需要 16+
```

### 数据采集失败

```bash
# 查看采集日志
curl http://localhost:3000/api/logs

# 手动测试采集
node src/collect-now.js

# 检查平台账号是否可用
# 在浏览器中手动登录 https://data-platform.synapath.com/annotator/login
```

### Nginx 502 错误

```bash
# 检查 Node 服务是否运行
pm2 status

# 检查 Nginx 配置
sudo nginx -t

# 检查 Nginx 日志
sudo tail -f /var/log/nginx/annotator-stats.error.log
```

## 文件结构

```
annotator-stats/
├── src/
│   ├── server.js          # Express 服务器
│   ├── config.js          # 配置加载
│   ├── database.js        # SQLite 数据库
│   ├── platformApi.js     # 平台 API 客户端
│   ├── collector.js       # 数据采集器
│   ├── import-data.js     # 数据导入脚本
│   ├── backfill.js        # 回填脚本
│   └── collect-now.js     # 即时采集脚本
├── public/
│   ├── index.html         # 前端页面
│   ├── css/
│   │   └── style.css      # 样式
│   └── js/
│       └── app.js         # 前端逻辑
├── data/
│   └── stats.db           # SQLite 数据库文件
├── .env                   # 环境变量配置
├── ecosystem.config.js    # PM2 配置
├── nginx.conf             # Nginx 配置
└── package.json           # 项目依赖
```
