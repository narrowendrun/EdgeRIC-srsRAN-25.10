#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"

sudo "${project_root}/build/apps/gnb/gnb" -c "${project_root}/gnb_rf_x310_tdd_n78_20mhz.yml"
