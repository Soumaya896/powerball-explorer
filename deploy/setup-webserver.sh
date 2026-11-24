#!/usr/bin/env bash
# Run ON Web01 and Web02 (Ubuntu). Usage:
#   sudo SERVER_NAME=web-01 REPO_URL=https://github.com/Soumaya896/powerball-explorer.git bash setup-webserver.sh
# (use SERVER_NAME=web-02 on the second server)
set -euo pipefail

SERVER_NAME="${SERVER_NAME:?set SERVER_NAME, e.g. web-01}"
REPO_URL="${REPO_URL:?set REPO_URL}"
APP_DIR=/opt/powerball-explorer

echo "==> Installing Node.js 20, nginx and git"
apt-get update -y
apt-get install -y curl git nginx
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Fetching the code into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO_URL" "$APP_DIR"; fi

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo ">>> Created $APP_DIR/.env - EDIT IT NOW and put your API_KEY in it:  sudo nano $APP_DIR/.env"
fi
grep -q '^SERVER_NAME=' "$APP_DIR/.env" || echo "SERVER_NAME=$SERVER_NAME" >> "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

echo "==> Creating systemd service"
cat > /etc/systemd/system/powerball.service <<UNIT
[Unit]
Description=Powerball Explorer
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=SERVER_NAME=$SERVER_NAME
Restart=always
RestartSec=3
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
UNIT
chown -R www-data:www-data "$APP_DIR"
systemctl daemon-reload
systemctl enable --now powerball
systemctl restart powerball

echo "==> Configuring nginx reverse proxy (port 80 -> 3000)"
cat > /etc/nginx/sites-available/powerball <<'NGINX'
server {
    listen 80 default_server;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/powerball /etc/nginx/sites-enabled/powerball
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Done. Test:  curl -i http://localhost/api/health"
