#!/usr/bin/env bash
# Build + push the four ComputerAgent images to AWS ECR.
#
#   harness-server       → examples/Dockerfile.harness's sibling
#                          (deploy/fullstack-base/harness-server.Dockerfile)
#   computeragent-server → examples/Dockerfile.harness
#   agentos-server       → packages/agentos-server/Dockerfile
#   agentos-spa          → agentos/Dockerfile  (uses VITE_AGENTOS_DEFAULT_*)
#
# Used by the GitHub Actions workflow AND as a local escape hatch.
#
#   AWS_ACCOUNT_ID=123456789012 ./scripts/build-and-push.sh
#
# Optional env overrides:
#   AWS_REGION         (default: us-east-1)
#   IMAGE_TAG          (default: $(git rev-parse --short HEAD))
#   PUSH               (default: 1 — set to 0 to skip pushes)
#   IMAGES             (default: all four — set to comma-separated subset like
#                       "harness-server,agentos-spa" to rebuild only those)
#   VITE_AGENTOS_DEFAULT_HARNESS  (default: claude-agent-sdk)
#   VITE_AGENTOS_DEFAULT_SOURCE   (default: github.com/shreyas-lyzr/general-agent)
#   VITE_AGENTOS_DEFAULT_MODEL    (default: claude-sonnet-4-6)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID required (12-digit AWS account id)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "${REPO_ROOT}" rev-parse --short HEAD)}"
PUSH="${PUSH:-1}"
IMAGES="${IMAGES:-harness-server,computeragent-server,agentos-server,agentos-spa}"

REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

VITE_HARNESS="${VITE_AGENTOS_DEFAULT_HARNESS:-claude-agent-sdk}"
VITE_SOURCE="${VITE_AGENTOS_DEFAULT_SOURCE:-github.com/shreyas-lyzr/general-agent}"
VITE_MODEL="${VITE_AGENTOS_DEFAULT_MODEL:-claude-sonnet-4-6}"

build_one() {
  local name="$1"
  local dockerfile="$2"
  local context="$3"
  local extra_args=("${@:4}")
  local repo="agentos/${name}"
  local image="${REGISTRY}/${repo}:${IMAGE_TAG}"

  echo
  echo "─── building ${name} ───"
  echo "  dockerfile : ${dockerfile}"
  echo "  context    : ${context}"
  echo "  image      : ${image}"

  docker build \
    -f "${dockerfile}" \
    -t "${image}" \
    -t "${REGISTRY}/${repo}:main" \
    "${extra_args[@]}" \
    "${context}"

  if [ "${PUSH}" = "1" ]; then
    docker push "${image}"
    docker push "${REGISTRY}/${repo}:main"
    echo "✓ pushed ${image}"
  else
    echo "✓ built ${image} (PUSH=0, skipping push)"
  fi
}

# Login to ECR up front so all four pushes reuse the auth.
if [ "${PUSH}" = "1" ]; then
  echo "─── logging in to ECR (${REGISTRY}) ───"
  aws ecr get-login-password --region "${AWS_REGION}" \
    | docker login --username AWS --password-stdin "${REGISTRY}"
fi

IFS=',' read -ra TARGETS <<< "${IMAGES}"
for img in "${TARGETS[@]}"; do
  case "${img}" in
    harness-server)
      # Bare harness — same Dockerfile, ENTRY override to harness-server.ts.
      build_one harness-server \
        "${REPO_ROOT}/examples/Dockerfile.harness" \
        "${REPO_ROOT}" \
        --build-arg "ENTRY=examples/harness-server.ts"
      ;;
    computeragent-server)
      # Default ENTRY in the Dockerfile already points at computeragent-server.ts.
      build_one computeragent-server \
        "${REPO_ROOT}/examples/Dockerfile.harness" \
        "${REPO_ROOT}"
      ;;
    agentos-server)
      build_one agentos-server \
        "${REPO_ROOT}/packages/agentos-server/Dockerfile" \
        "${REPO_ROOT}"
      ;;
    agentos-spa)
      build_one agentos-spa \
        "${REPO_ROOT}/agentos/Dockerfile" \
        "${REPO_ROOT}" \
        --build-arg "VITE_AGENTOS_DEFAULT_HARNESS=${VITE_HARNESS}" \
        --build-arg "VITE_AGENTOS_DEFAULT_SOURCE=${VITE_SOURCE}" \
        --build-arg "VITE_AGENTOS_DEFAULT_MODEL=${VITE_MODEL}"
      ;;
    *)
      echo "Unknown image: ${img}" >&2
      exit 1
      ;;
  esac
done

echo
echo "─── done ───"
echo "  tag: ${IMAGE_TAG}"
echo "  bump kustomize:"
for img in "${TARGETS[@]}"; do
  echo "    kustomize edit set image agentos/${img}=${REGISTRY}/agentos/${img}:${IMAGE_TAG}"
done
