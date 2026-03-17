#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_ID="${ALDARO_WORKSPACE_ID:-}"
API_BASE="${ALDARO_API_BASE_URL:-}"
SHARED_SECRET="${ALDARO_AGENT_SHARED_SECRET:-}"
JUPYTER_TOKEN="${ALDARO_JUPYTER_TOKEN:-}"
CODE_PASS="${ALDARO_CODE_SERVER_PASSWORD:-}"

if [[ -z "$WORKSPACE_ID" || -z "$API_BASE" || -z "$SHARED_SECRET" ]]; then
  echo "Missing required env vars."
  exit 1
fi

service ssh start || true

mkdir -p ~/.config/code-server
cat > ~/.config/code-server/config.yaml <<EOF
bind-addr: 0.0.0.0:8080
auth: password
password: ${CODE_PASS}
cert: false
EOF

nohup code-server >/var/log/code-server.log 2>&1 &
nohup jupyter lab --ip=0.0.0.0 --port=8888 --no-browser --NotebookApp.token="${JUPYTER_TOKEN}" --NotebookApp.password="" >/var/log/jupyter.log 2>&1 &

python3 /opt/aldaro/verify.py > /opt/aldaro/verification.json
python3 /opt/aldaro/report_verify.py
python3 /opt/aldaro/heartbeat_loop.py
