# 标注员工作统计监控网站

自动从数据标注平台 `data-platform.synapath.com` 采集标注员每日工作数据，汇总展示并提供预警。

## 功能特性

- **多时间范围查询**：最近1天 / 3天 / 1周 / 15天 / 1个月，支持自定义起止日期
- **标注员搜索**：按名称实时模糊搜索
- **汇总数据**：原始时长、片段时长、无片段时长、无片段等效、结算参考、累计参考、日均时长、活跃天数
- **颜色预警**：日均原始时长 <3h 红色预警，3-5h 蓝色正常，>5h 绿色活跃
- **每日明细**：点击标注员查看逐日数据
- **CSV 导出**：一键导出当前查询结果
- **自动采集**：每30分钟采集当天，每天00:10补采前一天，首次启动回填30天
- **公开访问**：部署后无需登录即可查看

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| 数据库 | SQLite (better-sqlite3) |
| 定时任务 | node-cron |
| 前端 | 原生 HTML / CSS / JS |
| 进程管理 | PM2 |
| 反向代理 | Nginx |
| SSL 证书 | Let's Encrypt (certbot) |

## 项目结构

```
annotator-monitor/
├── src/
│   ├── config.js        # 配置读取（环境变量）
│   ├── db.js            # SQLite 建表 + 预编译语句
│   ├── collector.js     # 数据采集（登录/请求/入库）
│   ├── scheduler.js     # 定时任务（node-cron）
│   └── server.js        # Express 服务 + API 路由
├── public/
│   ├── index.html       # 页面结构
│   ├── style.css        # 样式
│   └── app.js           # 前端交互逻辑
├── deploy/
│   ├── nginx.conf       # Nginx 配置模板
│   └── deploy.sh        # 一键部署脚本
├── ecosystem.config.js   # PM2 配置
├── .env.example          # 环境变量模板
├── .gitignore
└── package.json
```

## 本地开发

### 环境要求

- Node.js >= 18
- npm

### 步骤

```bash
# 1. 安装依赖
cd annotator-monitor
npm install

# 2. 配置环境变量
cp .env.example .env
# 按需修改 .env 中的账号和端口

# 3. 启动服务（首次启动自动回填30天历史数据）
npm start
```

浏览器访问 `http://localhost:3000`。

### 命令行模式

```bash
# 仅回填最近30天（不启动服务，跑完退出）
npm run backfill

# 仅采集当天一次（不启动服务，跑完退出）
npm run collect:once
```

## 服务器部署

### 方式一：一键部署脚本（推荐）

适用于 Ubuntu / Debian 服务器。

```bash
# 1. 将项目上传到服务器（git clone 或 scp）
git clone <your-repo-url> /opt/annotator-monitor
cd /opt/annotator-monitor

# 2. 修改 nginx.conf 中的域名
vim deploy/nginx.conf
# 将 your-domain.com 替换为你的实际域名

# 3. 执行部署脚本（传入域名参数）
bash deploy/deploy.sh your-domain.com
```

脚本会自动完成：
1. 安装 Node.js 20、Nginx、Certbot
2. 安装项目依赖和 PM2
3. 生成 .env 配置文件
4. 启动 PM2 进程并设置开机自启
5. 配置 Nginx 反向代理
6. 申请 Let's Encrypt SSL 证书并自动配置 HTTPS

部署完成后访问 `https://your-domain.com` 即可。

### 方式二：手动部署

#### 1. 安装系统依赖

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm nginx certbot python3-certbot-nginx

# 安装 Node.js 20
sudo npm install -g n
sudo n 20

# 安装 PM2
sudo npm install -g pm2
```

#### 2. 安装项目

```bash
cd /opt/annotator-monitor
npm install
cp .env.example .env
# 编辑 .env，填入平台账号和配置
vim .env
```

#### 3. 启动 PM2

```bash
mkdir -p logs data
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u $(whoami) --hp $HOME
```

#### 4. 配置 Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/annotator-monitor
# 替换域名
sudo sed -i 's/your-domain.com/实际域名/g' /etc/nginx/sites-available/annotator-monitor
sudo ln -sf /etc/nginx/sites-available/annotator-monitor /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

#### 5. 申请 SSL 证书

```bash
sudo certbot --nginx -d your-domain.com --redirect
```

## 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AM_PLATFORM_BASE_URL` | 数据标注平台地址 | `https://data-platform.synapath.com` |
| `AM_PLATFORM_EMAIL` | 平台登录邮箱 | `198176@qq.com` |
| `AM_PLATFORM_PASSWORD` | 平台登录密码 | `qwe123` |
| `AM_PLATFORM_ORG` | 所属组织 | `HC` |
| `AM_PORT` | 服务监听端口 | `3000` |
| `AM_DB_PATH` | SQLite 数据库路径 | `./data/stats.db` |
| `AM_BACKFILL_DAYS` | 首次回填天数 | `30` |
| `AM_NO_CLIP_FACTOR` | 无片段等效系数 | `0.2` |
| `AM_REQUEST_DELAY_MS` | 请求间隔（毫秒） | `800` |
| `AM_REQUEST_TIMEOUT_MS` | 请求超时（毫秒） | `30000` |

> 所有变量使用 `AM_` 前缀，避免与系统环境变量冲突。

## API 接口

### `GET /api/status`
系统状态：标注员数量、数据日期范围、采集状态、最近日志。

### `GET /api/summary`
汇总数据。参数：`range`（1d/3d/1w/15d/1m）或 `start`+`end`，可选 `search`。

### `GET /api/detail/:label`
某标注员每日明细。参数同 summary。

### `GET /api/export`
导出 CSV。参数同 summary。

### `POST /api/collect`
手动触发当天数据采集。

## 数据采集流程

```
登录平台 (POST /api/v1/annotator-auth/login)
    ↓ 获取 JWT token
循环调用统计 API (GET /api/v1/analytics/annotation-analytics?day=YYYY-MM-DD)
    ↓ 解析返回 JSON
计算无片段等效 = 无片段时长 × 0.2
计算结算参考 = 终审通过片段时长 + 无片段等效
    ↓ 写入 SQLite
前端通过本系统 API 查询展示
```

### 定时任务

| 频率 | 任务 |
|------|------|
| 每30分钟 | 采集当天最新数据 |
| 每天 00:10 | 补采前一天数据 |
| 首次启动 | 回填最近30天历史 |
| 服务启动 | 检查缺失日期并补采 |

## 运维命令

```bash
# 查看进程状态
pm2 status

# 查看实时日志
pm2 logs annotator-monitor

# 重启服务
pm2 restart annotator-monitor

# 停止服务
pm2 stop annotator-monitor

# 查看 Nginx 状态
sudo systemctl status nginx

# 手动触发采集（命令行）
pm2 trigger annotator-monitor collectToday
```

## 常见问题

### 首次启动数据为空
首次启动会自动回填30天历史数据，由于每天需要单独请求，回填需要几分钟。可在 `/api/status` 查看采集进度。

### 平台密码变更
修改 `.env` 中的 `AM_PLATFORM_PASSWORD`，然后 `pm2 restart annotator-monitor`。

### 数据库重置
```bash
pm2 stop annotator-monitor
rm -f data/stats.db data/stats.db-wal data/stats.db-shm
pm2 start annotator-monitor
# 会自动重新回填30天数据
```

### 端口被占用
修改 `.env` 中的 `AM_PORT`，同步修改 `deploy/nginx.conf` 中的 `proxy_pass` 端口，重启 PM2 和 Nginx。

### SSL 证书续期
Certbot 会自动安装定时续期任务。手动测试续期：
```bash
sudo certbot renew --dry-run
```
