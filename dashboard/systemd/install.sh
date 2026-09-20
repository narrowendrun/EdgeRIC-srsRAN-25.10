#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/../.." && pwd)"
install_user="${SUDO_USER:-narend}"
tailscale_ip="$(tailscale ip -4 | head -n 1)"
install_home="$(getent passwd "${install_user}" | cut -d: -f6)"
node_binary="$(runuser -u "${install_user}" -- /usr/bin/zsh -ic 'command -v node' 2>/dev/null | tail -n 1 || true)"

if [[ ! -x "${node_binary}" ]]; then
  node_binary="$(find "${install_home}/.nvm/versions/node" -mindepth 3 -maxdepth 3 -type f -path '*/bin/node' -executable -print 2>/dev/null | sort -V | tail -n 1 || true)"
fi

if [[ ! -x "${node_binary}" ]]; then
  echo "Node.js was not found for ${install_user}. Install Node.js 22 or newer." >&2
  exit 1
fi

node_major="$("${node_binary}" -p 'Number(process.versions.node.split(".")[0])')"
if ((node_major < 22)) || ! "${node_binary}" -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "Dashboard requires Node.js 22 or newer with node:sqlite; found $("${node_binary}" --version) at ${node_binary}." >&2
  exit 1
fi

node_dir="$(dirname -- "${node_binary}")"
npm_binary="${node_dir}/npm"

if [[ ! -x "${project_root}/build/apps/gnb/gnb" ]]; then
  echo "gNB binary not found at ${project_root}/build/apps/gnb/gnb" >&2
  exit 1
fi

if [[ ! -x "${project_root}/.venv/bin/python" ]]; then
  echo "Project virtual environment not found at ${project_root}/.venv" >&2
  exit 1
fi

if [[ ! -x "${npm_binary}" ]]; then
  echo "npm was not found next to ${node_binary}." >&2
  exit 1
fi

echo "Building dashboard with $("${node_binary}" --version) from ${node_binary}"
runuser -u "${install_user}" -- env \
  PATH="${node_dir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin" \
  "${npm_binary}" --prefix "${project_root}/dashboard" run build

install -d -o "${install_user}" -g "${install_user}" -m 0755 "${project_root}/logs" "${project_root}/logs/runs"

render_unit() {
  local source_file="$1"
  local destination_file="$2"
  local temporary_file
  temporary_file="$(mktemp)"
  sed \
    -e "s|@PROJECT_ROOT@|${project_root}|g" \
    -e "s|@USER@|${install_user}|g" \
    -e "s|@TAILSCALE_IP@|${tailscale_ip}|g" \
    -e "s|@NODE_DIR@|${node_dir}|g" \
    -e "s|@NODE@|${node_binary}|g" \
    "${source_file}" > "${temporary_file}"
  install -o root -g root -m 0644 "${temporary_file}" "${destination_file}"
  rm -f -- "${temporary_file}"
}

render_unit "${script_dir}/edgeric-gnb.service.in" /etc/systemd/system/edgeric-gnb.service
render_unit "${script_dir}/edgeric-collector.service.in" /etc/systemd/system/edgeric-collector.service
render_unit "${script_dir}/edgeric-metrics-recorder.service.in" /etc/systemd/system/edgeric-metrics-recorder.service
render_unit "${script_dir}/edgeric-dashboard.service.in" /etc/systemd/system/edgeric-dashboard.service
install -o root -g root -m 0644 "${script_dir}/edgeric-open5gs.service" /etc/systemd/system/edgeric-open5gs.service

sudoers_file="$(mktemp)"
cat > "${sudoers_file}" <<EOF
Cmnd_Alias EDGERIC_DASHBOARD_SYSTEMCTL = /usr/bin/systemctl start edgeric-gnb.service, /usr/bin/systemctl stop edgeric-gnb.service, /usr/bin/systemctl restart edgeric-gnb.service, /usr/bin/systemctl start edgeric-collector.service, /usr/bin/systemctl stop edgeric-collector.service, /usr/bin/systemctl restart edgeric-collector.service, /usr/bin/systemctl start edgeric-open5gs.service, /usr/bin/systemctl stop edgeric-open5gs.service, /usr/bin/systemctl restart edgeric-open5gs.service
${install_user} ALL=(root) NOPASSWD: EDGERIC_DASHBOARD_SYSTEMCTL
EOF
visudo -cf "${sudoers_file}"
install -o root -g root -m 0440 "${sudoers_file}" /etc/sudoers.d/edgeric-dashboard
rm -f -- "${sudoers_file}"

systemctl daemon-reload
systemctl enable edgeric-dashboard.service
systemctl restart edgeric-dashboard.service

dashboard_ready=false
for _ in {1..20}; do
  if curl --fail --silent --max-time 1 "http://${tailscale_ip}:4173/api/health" >/dev/null; then
    dashboard_ready=true
    break
  fi
  sleep 0.25
done

if [[ "${dashboard_ready}" != true ]]; then
  echo "Dashboard service did not become healthy." >&2
  systemctl status edgeric-dashboard.service --no-pager -l >&2 || true
  journalctl -u edgeric-dashboard.service -n 30 --no-pager >&2 || true
  exit 1
fi

echo "Dashboard installed at http://vriika-fiend:4173"
echo "Open5GS WebUI proxy available at http://vriika-fiend:4174"
echo "Stop terminal-owned gNB/collector processes before using the dashboard to start managed copies."
