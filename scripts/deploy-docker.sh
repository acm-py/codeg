#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

PORT="${CODEG_PORT:-3080}"
HOST_HOME="${CODEG_HOST_HOME:-${HOME:-}}"
BREW_HOME="${CODEG_HOST_BREW_HOME:-}"
IMAGE="${CODEG_IMAGE:-ghcr.io/xintaofei/codeg:latest}"
ENV_FILE=""
NO_PULL=0

usage() {
  printf '%s\n' \
    'Usage: bash scripts/deploy-docker.sh [options]' \
    '' \
    'Options:' \
    '  --port PORT          Host port (default: CODEG_PORT or 3080)' \
    '  --host-home DIR      Host home directory (default: $HOME)' \
    '  --brew-home DIR      Host Homebrew prefix' \
    '  --image IMAGE        Container image' \
    '  --env-file FILE      Existing Compose env file to include' \
    '  --no-pull            Do not pull the container image' \
    '  --help               Show this help'
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --port)
      (($# >= 2)) || die "--port requires a value"
      PORT=$2
      shift 2
      ;;
    --host-home)
      (($# >= 2)) || die "--host-home requires a value"
      HOST_HOME=$2
      shift 2
      ;;
    --brew-home)
      (($# >= 2)) || die "--brew-home requires a value"
      BREW_HOME=$2
      shift 2
      ;;
    --image)
      (($# >= 2)) || die "--image requires a value"
      IMAGE=$2
      shift 2
      ;;
    --env-file)
      (($# >= 2)) || die "--env-file requires a value"
      ENV_FILE=$2
      shift 2
      ;;
    --no-pull)
      NO_PULL=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || die "this deployment script currently supports Linux hosts only (host-agent mounts use Linux ELF binaries)"
command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (use 'docker compose')"

[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || die "port must be an integer from 1 to 65535"
[[ -n "$HOST_HOME" && -d "$HOST_HOME" ]] || die "host home must be an existing directory: $HOST_HOME"
HOST_HOME=$(cd -- "$HOST_HOME" && pwd)

if [[ -n "$BREW_HOME" ]]; then
  [[ -d "$BREW_HOME" ]] || die "brew home must be an existing directory: $BREW_HOME"
else
  for candidate in /home/linuxbrew/.linuxbrew "${HOME:-}/.linuxbrew" /opt/homebrew; do
    if [[ -n "$candidate" && -d "$candidate" ]]; then
      BREW_HOME=$candidate
      break
    fi
  done
  if [[ -z "$BREW_HOME" ]]; then
    BREW_HOME=/home/linuxbrew/.linuxbrew
    printf 'Warning: no Homebrew prefix found; using %s\n' "$BREW_HOME" >&2
  fi
fi
BREW_HOME=$(cd -- "$BREW_HOME" 2>/dev/null && pwd) || die "cannot resolve brew home: $BREW_HOME"

if [[ -n "$ENV_FILE" && ! -f "$ENV_FILE" ]]; then
  die "env file does not exist: $ENV_FILE"
fi

login_path=""
if [[ -n "${SHELL:-}" && -x "${SHELL}" ]]; then
  login_path=$("$SHELL" -ilc 'printf %s "$PATH"' 2>/dev/null || true)
fi
[[ -n "$login_path" ]] || login_path=$PATH

is_system_path() {
  case "$1" in
    /bin|/sbin|/usr/bin|/usr/sbin|/usr/local/bin|/usr/local/sbin) return 0 ;;
    *) return 1 ;;
  esac
}

HOST_AGENT_PATH="${CODEG_HOST_AGENT_PATH:-}"
declare -A agent_path_dirs=()
declare -A seen_path=()
IFS=: read -r -a existing_agent_path_dirs <<< "$HOST_AGENT_PATH"
for path_dir in "${existing_agent_path_dirs[@]}"; do
  [[ -n "$path_dir" ]] && seen_path["$path_dir"]=1
done

printf 'Agent detection:\n'
AGENTS=(claude codex gemini opencode cursor-agent cline goose amp kiro-cli qwen kimi pi uv node python3 rg)
for agent in "${AGENTS[@]}"; do
  if agent_path=$(PATH="$login_path" command -v "$agent" 2>/dev/null); then
    agent_dir=$(dirname -- "$agent_path")
    is_system_path "$agent_dir" || agent_path_dirs["$agent_dir"]=1
    version=$(PATH="$login_path" "$agent_path" --version 2>/dev/null || PATH="$login_path" "$agent_path" -V 2>/dev/null || true)
    version=${version//$'\n'/ }
    printf '  found     %-12s %s' "$agent" "$agent_path"
    [[ -n "$version" ]] && printf ' (%s)' "$version"
    printf '\n'
  else
    printf '  not found %-12s\n' "$agent"
  fi
done

for path_dir in "${!agent_path_dirs[@]}"; do
  [[ -n "${seen_path[$path_dir]+x}" ]] && continue
  HOST_AGENT_PATH="${HOST_AGENT_PATH:+$HOST_AGENT_PATH:}$path_dir"
  seen_path["$path_dir"]=1
done

printf 'Agent configuration:\n'
CONFIG_PATHS=(
  "$HOST_HOME/.claude" "$HOST_HOME/.codex" "$HOST_HOME/.gemini"
  "$HOST_HOME/.config/opencode" "$HOST_HOME/.cursor" "$HOST_HOME/.cline"
  "$HOST_HOME/.config/goose" "$HOST_HOME/.config/amp" "$HOST_HOME/.config/kiro"
  "$HOST_HOME/.qwen" "$HOST_HOME/.kimi" "$HOST_HOME/.pi"
)
for config_path in "${CONFIG_PATHS[@]}"; do
  [[ -e "$config_path" ]] && printf '  found     %s\n' "$config_path"
done

COMPOSE=(docker compose --project-directory "$ROOT_DIR")
if [[ -n "$ENV_FILE" ]]; then
  COMPOSE+=(--env-file "$ENV_FILE")
fi
compose_env=(
  "CODEG_HOST_HOME=$HOST_HOME"
  "CODEG_HOST_BREW_HOME=$BREW_HOME"
  "CODEG_HOST_PORT=$PORT"
  "CODEG_PORT=3080"
  "CODEG_IMAGE=$IMAGE"
  "CODEG_HOST_AGENT_PATH=$HOST_AGENT_PATH"
  "CODEG_AGENT_RUNTIME=${CODEG_AGENT_RUNTIME:-host}"
)
[[ -v CODEG_AGENT_PATH ]] && compose_env+=("CODEG_AGENT_PATH=$CODEG_AGENT_PATH")
[[ -v CODEG_TOKEN ]] && compose_env+=("CODEG_TOKEN=$CODEG_TOKEN")
if ((NO_PULL == 0)); then
  printf 'Pulling image %s...\n' "$IMAGE"
  env "${compose_env[@]}" "${COMPOSE[@]}" pull
fi
printf 'Starting Codeg...\n'
env "${compose_env[@]}" "${COMPOSE[@]}" up -d --force-recreate
env "${compose_env[@]}" "${COMPOSE[@]}" ps

printf '\nCodeg is available at http://localhost:%s\n' "$PORT"
printf 'Security warning: the host-agent container can read mounted host configuration and credentials.\n'
