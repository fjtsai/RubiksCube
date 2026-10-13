#!/bin/bash
# RubiksCube PWA - user-level service setup

set -euo pipefail

APP_DIR="/home/fjtsai/RubiksCube"
UNIT_DIR="/home/fjtsai/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/rubiks-cube.service"

mkdir -p "$UNIT_DIR"

cd "$APP_DIR"
npm run build

cat > "$UNIT_FILE" <<'EOF'
[Unit]
Description=RubiksCube PWA Game Server (port 9983)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/fjtsai/RubiksCube
ExecStart=/usr/bin/python3 /home/fjtsai/RubiksCube/serve_game.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now rubiks-cube

echo "RubiksCube service is ready:"
systemctl --user status rubiks-cube --no-pager
