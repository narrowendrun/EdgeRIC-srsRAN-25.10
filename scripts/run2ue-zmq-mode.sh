#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"
ue_root="${project_root}/../srsRAN_4G"
ue_binary="${ue_root}/build/srsue/src/srsue"

if [[ ! -x "${ue_binary}" ]]; then
  echo "srsUE binary not found at ${ue_binary}; run ./scripts/make-ue.sh first" >&2
  exit 1
fi

sudo "${ue_binary}" "${project_root}/configs-srsue/ue1-4g-zmq.conf" &

sleep 2
sudo "${ue_binary}" "${project_root}/configs-srsue/ue2-4g-zmq.conf"
