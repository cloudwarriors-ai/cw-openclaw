#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is required."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required."
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required."
  exit 1
fi

models_json="$(curl -sS https://openrouter.ai/api/v1/embeddings/models \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}")"

preferred_order=(
  "openai/text-embedding-3-large"
  "qwen/qwen3-embedding-8b"
  "openai/text-embedding-3-small"
)

recommended=""
for model in "${preferred_order[@]}"; do
  if echo "${models_json}" | jq -e --arg model "${model}" '.data[] | select(.id == $model)' >/dev/null; then
    recommended="${model}"
    break
  fi
done

if [[ -z "${recommended}" ]]; then
  recommended="$(echo "${models_json}" | jq -r '.data[0].id // empty')"
fi

if [[ -z "${recommended}" ]]; then
  echo "No embedding models returned from OpenRouter."
  exit 1
fi

echo "Recommended embedding model: ${recommended}"
echo
echo "Top available options (id, input_cost_per_1M_tokens_usd, context_length):"
echo "${models_json}" \
  | jq -r '
      .data
      | map({
          id,
          prompt_cost_per_1m: ((.pricing.prompt | tonumber) * 1000000),
          context_length
        })
      | sort_by(.prompt_cost_per_1m)
      | .[:10]
      | .[]
      | [.id, (.prompt_cost_per_1m|tostring), (.context_length|tostring)]
      | @tsv
    '
