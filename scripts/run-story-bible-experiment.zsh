#!/bin/zsh

set -euo pipefail

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
cd "$project_dir"
vitest_bin="$project_dir/node_modules/.bin/vitest"
if [[ ! -x "$vitest_bin" ]]; then
  echo "缺少本地 Vitest。请先运行 npm install，再重试实验。"
  exit 1
fi

default_sample="${STORY_BIBLE_SAMPLE_PATH:-$PWD/../血字的研究_前3章.txt}"
if [[ -f "$default_sample" ]]; then
  sample_path="$default_sample"
else
  read -r "sample_path?三章样本路径: "
fi
if [[ ! -f "$sample_path" ]]; then
  echo "找不到样本文件：$sample_path"
  exit 1
fi

default_base_url="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"
read -r "base_url?Base URL [$default_base_url]: "
base_url="${base_url:-$default_base_url}"

if [[ -n "${DEEPSEEK_MODEL:-}" ]]; then
  read -r "model?模型 ID [$DEEPSEEK_MODEL]: "
  model="${model:-$DEEPSEEK_MODEL}"
else
  read -r "model?模型 ID（请填设置页中已验证的 V4 Flash ID）: "
fi
if [[ -z "$model" ]]; then
  echo "模型 ID 不能为空"
  exit 1
fi

read -rs "api_key?API Key（输入不显示，仅本次进程使用）: "
echo
if [[ -z "$api_key" ]]; then
  echo "API Key 不能为空"
  exit 1
fi
trap 'unset api_key' EXIT

RUN_STORY_BIBLE_DEEPSEEK=1 \
DEEPSEEK_API_KEY="$api_key" \
DEEPSEEK_BASE_URL="$base_url" \
DEEPSEEK_MODEL="$model" \
STORY_BIBLE_SAMPLE_PATH="$sample_path" \
"$vitest_bin" run lib/story-bible/deepseek.integration.test.ts \
  --testTimeout=1200000 \
  --maxWorkers=1
