#!/usr/bin/env bash
set -euo pipefail

# sudo apt-get install cmake make gcc g++ pkg-config libfftw3-dev libmbedtls-dev libsctp-dev libyaml-cpp-dev libgtest-dev libzmq3-dev
# git clone https://github.com/ushasigh/srsRAN_Project.git

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"
build_dir="${project_root}/build"

rm -rf -- "${build_dir}"
cmake -S "${project_root}" -B "${build_dir}" -DENABLE_EXPORT=ON -DENABLE_ZEROMQ=ON
cmake --build "${build_dir}" --parallel "$(nproc)"
