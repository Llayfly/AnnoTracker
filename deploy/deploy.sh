#!/usr/bin/env bash
# ===== 一键部署脚本（Linux 服务器，Ubuntu/Debian）=====
# 用法：在服务器上 git clone 项目后，cd 进项目目录，执行 bash deploy/deploy.sh
# 请先修改 deploy/nginx.conf 中的 your-domain.com 为实际域名
set -e

DOMAIN="${1:-your-domain.com}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=============================="
echo " 标注员工作统计监控 - 部署"
echo " 域名: $DOMAIN"
echo " 项目: $PROJECT_DIR"
echo "=============================="

# 1. 安装系统依赖
echo "[1/7] 安装系统依赖..."
sudo apt-get update -y
sudo apt-get install -y nodejs npm nginx certbot python3-certbot-nginx

# 2. 安装 Node 版本管理(确保 Node>=18)
if ! command -v n &>/dev/null; then
  echo "[2/7] 安装 n (Node 版本管理)..."
  sudo npm install -g n
fi
sudo n 20

# 3. 安装项目依赖
echo "[3/7] 安装项目依赖..."
cd "$PROJECT_DIR"
npm install
npm install -g pm2

# 4. 配置环境变量
echo "[4/7] 配置环境变量..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "已生成 .env，请按需修改其中的账号/端口配置"
fi

# 5. 创建日志目录并启动 PM2
echo "[5/7] 启动 PM2 进程..."
mkdir -p logs data
pm2 delete annotator-monitor 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
sudo env PATH=$PATH:/usr/local/bin pm2 startup systemd -u $USER --hp $HOME

# 6. 配置 Nginx
echo "[6/7] 配置 Nginx..."
sudo cp deploy/nginx.conf /etc/nginx/sites-available/annotator-monitor
sudo sed -i "s/your-domain.com/$DOMAIN/g" /etc/nginx/sites-available/annotator-monitor
sudo ln -sf /etc/nginx/sites-available/annotator-monitor /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# 7. 申请 SSL 证书 (Let's Encrypt)
echo "[7/7] 申请 Let's Encrypt SSL 证书..."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect

echo "=============================="
echo " 部署完成！"
echo " 访问: http://$DOMAIN"
echo " 状态: pm2 status"
echo " 日志: pm2 logs annotator-monitor"
echo " 首次启动会自动回填最近30天数据，请耐心等待几分钟"
echo "=============================="
