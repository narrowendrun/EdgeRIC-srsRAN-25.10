#!/usr/bin/env bash
set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"
dashboard_root="${project_root}/dashboard"

managed_units=(
  edgeric-gnb.service
  edgeric-collector.service
  edgeric-metrics-recorder.service
  edgeric-open5gs.service
  edgeric-dashboard.service
)

open5gs_units=(
  open5gs-webui.service
  open5gs-udrd.service
  open5gs-bsfd.service
  open5gs-nssfd.service
  open5gs-pcfd.service
  open5gs-udmd.service
  open5gs-ausfd.service
  open5gs-seppd.service
  open5gs-scpd.service
  open5gs-nrfd.service
  open5gs-pcrfd.service
  open5gs-hssd.service
  open5gs-upfd.service
  open5gs-sgwud.service
  open5gs-amfd.service
  open5gs-smfd.service
  open5gs-sgwcd.service
  open5gs-mmed.service
)

unit_exists() {
  systemctl cat "$1" >/dev/null 2>&1
}

stop_unit() {
  local unit="$1"
  if unit_exists "${unit}"; then
    echo "Stopping ${unit}"
    sudo /usr/bin/systemctl stop "${unit}" || true
  fi
}

echo "Stopping the EdgeRIC OTA stack..."
sudo -v

# Stop producers before consumers, and stop the dashboard last.
stop_unit edgeric-gnb.service
stop_unit edgeric-collector.service
stop_unit edgeric-metrics-recorder.service
stop_unit edgeric-open5gs.service

# The wrapper can be inactive while individual Open5GS daemons are still active.
installed_open5gs_units=()
for unit in "${open5gs_units[@]}"; do
  if unit_exists "${unit}"; then
    installed_open5gs_units+=("${unit}")
  fi
done
if ((${#installed_open5gs_units[@]})); then
  echo "Stopping Open5GS services"
  sudo /usr/bin/systemctl stop "${installed_open5gs_units[@]}" || true
fi

stop_unit edgeric-dashboard.service

# Clean up terminal-started copies that are outside systemd supervision. Only
# known runtimes whose working directory belongs to this checkout are matched.
runtime_pids=()
for proc_dir in /proc/[0-9]*; do
  pid="${proc_dir##*/}"
  [[ "${pid}" == "$$" || "${pid}" == "${PPID}" ]] && continue

  cwd="$(readlink -f "${proc_dir}/cwd" 2>/dev/null)" || continue
  command="$(tr '\0' ' ' < "${proc_dir}/cmdline" 2>/dev/null)" || continue
  comm="$(<"${proc_dir}/comm")" || continue

  matched=false
  if [[ "${comm}" == "gnb" && ("${cwd}" == "${project_root}"* || "${command}" == *"${project_root}/build/apps/gnb/gnb"*) ]]; then
    matched=true
  elif [[ "${comm}" == python* && ("${cwd}" == "${project_root}"* || "${command}" == *"${project_root}/edgeric/"*) ]]; then
    if [[ "${command}" =~ (collector|metrics_recorder|mcs_muapp|scheduling_muapp)\.py([[:space:]]|$) ]]; then
      matched=true
    fi
  elif [[ "${comm}" == "node" && ("${cwd}" == "${dashboard_root}"* || "${command}" == *"${dashboard_root}/"*) ]]; then
    matched=true
  fi

  if [[ "${matched}" == true ]]; then
    runtime_pids+=("${pid}")
  fi
done

if ((${#runtime_pids[@]})); then
  echo "Stopping unmanaged project processes: ${runtime_pids[*]}"
  sudo /usr/bin/kill -INT -- "${runtime_pids[@]}" 2>/dev/null || true

  for _ in {1..20}; do
    remaining_pids=()
    for pid in "${runtime_pids[@]}"; do
      if sudo /usr/bin/kill -0 "${pid}" 2>/dev/null; then
        remaining_pids+=("${pid}")
      fi
    done
    ((${#remaining_pids[@]} == 0)) && break
    sleep 0.25
  done

  if ((${#remaining_pids[@]})); then
    echo "Force-stopping remaining processes: ${remaining_pids[*]}"
    sudo /usr/bin/kill -KILL -- "${remaining_pids[@]}" 2>/dev/null || true
  fi
fi

still_active=()
for unit in "${managed_units[@]}" "${open5gs_units[@]}"; do
  if systemctl is-active --quiet "${unit}" 2>/dev/null; then
    still_active+=("${unit}")
  fi
done

if ((${#still_active[@]})); then
  echo "Some services are still active: ${still_active[*]}" >&2
  exit 1
fi

echo "EdgeRIC OTA stack stopped."
