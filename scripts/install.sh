#!/usr/bin/env bash
# Install Agent Workflow Kit and optionally configure OpenCode's Fable agent.
set -euo pipefail

REPOSITORY="${AGENT_WORKFLOW_REPOSITORY:-https://github.com/Baggrisha/agent-workflow-kit.git}"
REF="${AGENT_WORKFLOW_REF:-main}"
FABLE_MODEL="${FABLE_MODEL:-}"
FABLE_VARIANT="${FABLE_VARIANT:-high}"
CLAUDE_MODEL="${CLAUDE_MODEL:-}"
CLAUDE_VARIANT="${CLAUDE_VARIANT:-high}"
TARGET=""

usage() {
  cat <<'EOF'
Usage: install.sh [options] /path/to/project

Downloads Agent Workflow Kit, applies it to the target project, then configures
the global OpenCode `fable` and `claude` agents. In an interactive terminal,
choose a model for each agent.

Options:
  --fable-model MODEL   OpenCode provider/model ID, or "keep"
  --fable-variant NAME  Model variant (default: high)
  --claude-model MODEL  OpenCode provider/model ID, or "keep"
  --claude-variant NAME Model variant (default: high)
  --ref GIT_REF         Kit Git ref (default: main)
  --pack NAME           Forward an optional pack to apply-kit.sh
  --force               Overwrite kit files already in target
  -h, --help            Show this help
EOF
}

APPLY_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --fable-model)
      FABLE_MODEL="${2:?--fable-model requires a model}"
      shift 2
      ;;
    --fable-variant)
      FABLE_VARIANT="${2:?--fable-variant requires a variant}"
      shift 2
      ;;
    --claude-model)
      CLAUDE_MODEL="${2:?--claude-model requires a model}"
      shift 2
      ;;
    --claude-variant)
      CLAUDE_VARIANT="${2:?--claude-variant requires a variant}"
      shift 2
      ;;
    --ref)
      REF="${2:?--ref requires a Git ref}"
      shift 2
      ;;
    --pack)
      APPLY_ARGS+=(--pack "${2:?--pack requires a pack name}")
      shift 2
      ;;
    --force)
      APPLY_ARGS+=(--force)
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$TARGET" ]; then
        echo "Only one target project may be specified." >&2
        exit 2
      fi
      TARGET="$1"
      shift
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  usage >&2
  exit 2
fi

if [ ! -d "$TARGET/.git" ]; then
  echo "Target must be an existing Git project: $TARGET" >&2
  exit 2
fi

choose_model() {
  local agent="$1"
  local model="$2"
  local variant="$3"
  if [ -n "$model" ] || [ ! -t 0 ]; then
    SELECTED_MODEL="$model"
    SELECTED_VARIANT="$variant"
    return
  fi

  echo "Choose the model for OpenCode's $agent agent:"
  select choice in "GPT-5.6 Sol (recommended)" "Custom model" "Keep current configuration"; do
    case "$REPLY" in
      1)
        model="openai/gpt-5.6-sol"
        variant="high"
        break
        ;;
      2)
        read -r -p "Provider/model ID (GPT, Gemini, etc.): " model
        [ -n "$model" ] || { echo "Model cannot be empty." >&2; continue; }
        read -r -p "Variant [$variant]: " selected_variant
        variant="${selected_variant:-$variant}"
        break
        ;;
      3)
        model="keep"
        break
        ;;
      *) echo "Enter 1, 2, or 3." ;;
    esac
  done
  SELECTED_MODEL="$model"
  SELECTED_VARIANT="$variant"
}

choose_model fable "$FABLE_MODEL" "$FABLE_VARIANT"
FABLE_MODEL="${SELECTED_MODEL:-keep}"
FABLE_VARIANT="${SELECTED_VARIANT:-$FABLE_VARIANT}"
choose_model claude "$CLAUDE_MODEL" "$CLAUDE_VARIANT"
CLAUDE_MODEL="${SELECTED_MODEL:-keep}"
CLAUDE_VARIANT="${SELECTED_VARIANT:-$CLAUDE_VARIANT}"

if [ "$FABLE_MODEL" != "keep" ] && [[ "$FABLE_MODEL" != */* ]]; then
  echo "fable model must be a provider/model ID: $FABLE_MODEL" >&2
  exit 2
fi
if [ "$CLAUDE_MODEL" != "keep" ] && [[ "$CLAUDE_MODEL" != */* ]]; then
  echo "claude model must be a provider/model ID: $CLAUDE_MODEL" >&2
  exit 2
fi

command -v git >/dev/null 2>&1 || {
  echo "git is required." >&2
  exit 1
}

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-workflow-kit.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
KIT_ROOT="$TMP_ROOT/kit"
git clone --depth 1 --branch "$REF" "$REPOSITORY" "$KIT_ROOT"
"$KIT_ROOT/scripts/apply-kit.sh" "${APPLY_ARGS[@]}" "$TARGET"

write_agent() {
  local agent="$1"
  local model="$2"
  local variant="$3"
  CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  AGENT_PATH="$CONFIG_HOME/opencode/agent/$agent.md"
  mkdir -p "$(dirname "$AGENT_PATH")"
  if [ -e "$AGENT_PATH" ]; then
    cp "$AGENT_PATH" "$AGENT_PATH.bak"
    echo "backup: $AGENT_PATH.bak"
  fi
  cat > "$AGENT_PATH" <<EOF
---
description: Handles $agent tasks.
mode: all
model: $model
variant: $variant
---

Handle $agent tasks.
EOF
  echo "$agent model: $model ($variant)"
}

if [ "$FABLE_MODEL" != "keep" ]; then
  write_agent fable "$FABLE_MODEL" "$FABLE_VARIANT"
fi
if [ "$CLAUDE_MODEL" != "keep" ]; then
  write_agent claude "$CLAUDE_MODEL" "$CLAUDE_VARIANT"
fi

echo "Installed Agent Workflow Kit in: $TARGET"
echo "Restart OpenCode before using the Fable configuration."
