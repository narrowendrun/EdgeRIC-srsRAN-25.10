#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"
ue_root="${project_root}/../srsRAN_4G"
build_dir="${ue_root}/build"

if [[ ! -f "${ue_root}/CMakeLists.txt" ]]; then
  echo "srsRAN_4G source tree not found at ${ue_root}" >&2
  exit 1
fi

rm -rf -- "${build_dir}"
cmake -S "${ue_root}" -B "${build_dir}"
cmake --build "${build_dir}" --parallel "$(nproc)"
