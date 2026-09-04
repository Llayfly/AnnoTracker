#!/bin/bash
# 标注员统计系统一键部署脚本
# 用法: bash deploy.sh [域名]
# 示例: bash deploy.sh stats.example.com

set -e

DOMAIN=${1:-}
PROJECT_DIR=$(cd "$(dirname "$0")" && pwd)

echo "=========================================="
echo "  标注员统计系统部署脚本"
echo "=========================================="
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
  echo "❌ 未检测到 Node.js，正在安装..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "✅ Node.js 版本: $(node -v)"

# 安装依赖
echo ""
echo "📦 安装项目依赖..."
cd "$PROJECT_DIR"
npm install

# 安装 PM2
if ! command -v pm2 &> /dev/null; then
  echo ""
  echo "📦 安装 PM2..."
  sudo npm install -g pm2
fi

# 创建日志目录
mkdir -p logs

# 检查 .env 文件
if [ ! -f .env ]; then
  echo ""
  echo "⚙️  创建配置文件..."
  cp .env.example .env
  echo "⚠️  请编辑 .env 文件设置平台账号密码: vi $PROJECT_DIR/.env"
fi

# 更新 ecosystem.config.js 中的路径
sed -i "s|cwd:.*|cwd: '$PROJECT_DIR',|" ecosystem.config.js
sed -i "s|error_file:.*|error_file: '$PROJECT_DIR/logs/error.log',|" ecosystem.config.js
sed -i "s|out_file:.*|out_file: '$PROJECT_DIR/logs/output.log',|" ecosystem.config.js

# 启动 PM2
echo ""
echo "🚀 启动服务..."
pm2 delete annotator-stats 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# 配置 Nginx
if command -v nginx &> /dev/null; then
  echo ""
  echo "🌐 配置 Nginx..."

  if [ -n "$DOMAIN" ]; then
    sed "s/your-domain.com/$DOMAIN/g" nginx.conf | sudo tee /etc/nginx/sites-available/annotator-stats > /dev/null
  else
    sudo cp nginx.conf /etc/nginx/sites-available/annotator-stats
  fi

  sudo ln -sf /etc/nginx/sites-available/annotator-stats /etc/nginx/sites-enabled/annotator-stats

  if sudo nginx -t 2>&1; then
    sudo systemctl reload nginx
    echo "✅ Nginx 配置完成"
  else
    echo "❌ Nginx 配置测试失败，请手动检查"
  fi

  # 配置 SSL
  if [ -n "$DOMAIN" ]; then
    echo ""
    echo "🔒 配置 SSL 证书..."
    if command -v certbot &> /dev/null; then
      sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos
      echo "✅ SSL 配置完成"
    else
      echo "⚠️  certbot 未安装，跳过 SSL 配置"
      echo "   安装: sudo apt install certbot python3-certbot-nginx"
      echo "   配置: sudo certbot --nginx -d $DOMAIN"
    fi
  fi
else
  echo "⚠️  Nginx 未安装，跳过反向代理配置"
  echo "   服务已启动在端口 3000"
fi

echo ""
echo "=========================================="
echo "  ✅ 部署完成!"
echo "=========================================="
echo ""
if [ -n "$DOMAIN" ]; then
  echo "🌐 访问地址: http://$DOMAIN"
  echo "🔒 HTTPS地址: https://$DOMAIN"
else
  echo "🌐 访问地址: http://localhost:3000"
  echo "   如需公网访问，请配置 Nginx 和域名"
fi
echo ""
echo "📋 常用命令:"
echo "  查看状态: pm2 status"
echo "  查看日志: pm2 logs annotator-stats"
echo "  重启服务: pm2 restart annotator-stats"
echo "  回填数据: node src/backfill.js 30"
echo ""
