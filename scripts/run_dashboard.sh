#!/usr/bin/env bash
set -euo pipefail

if ! systemctl cat edgeric-dashboard.service >/dev/null 2>&1; then
  echo "Dashboard service is not installed. Run: sudo ./dashboard/systemd/install.sh" >&2
  exit 1
fi

sudo systemctl restart edgeric-dashboard.service

dashboard_ip="$(tailscale ip -4 | head -n 1)"
dashboard_ready=false
for _ in {1..20}; do
  if curl --fail --silent --max-time 1 "http://${dashboard_ip}:4173/api/health" >/dev/null; then
    dashboard_ready=true
    break
  fi
  sleep 0.25
done

if [[ "${dashboard_ready}" != true ]]; then
  echo "Dashboard failed to start. Recent service status:" >&2
  systemctl status edgeric-dashboard.service --no-pager -l >&2 || true
  exit 1
fi

echo "Dashboard: http://vriika-fiend:4173"
