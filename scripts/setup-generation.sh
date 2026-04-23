#!/usr/bin/env bash
# scripts/setup-generation.sh
#
# One-shot installer for the three new generation capabilities:
#   1. npm packages (pdfkit, exceljs) — xlsx + structured PDF
#   2. stable-diffusion.cpp with Metal — local image generation
#   3. SDXL base 1.0 checkpoint (6.5 GB) — the model itself
#
# Each step is interactive: you get a y/N prompt before anything heavy runs.
# Designed to be idempotent — re-running it just skips whatever is already
# done.
#
# Run from inside the repo root:
#     zsh scripts/setup-generation.sh
# or
#     bash scripts/setup-generation.sh

set -e
set -u

# ─── locate repo root ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

HOME_DIR="$REPO_ROOT/.tmp/melo-home-user"
SD_MODEL_DIR="$HOME_DIR/sd-models"
SD_BIN_DIR="$HOME_DIR/sd-bin"
SD_SRC_DIR="$HOME_DIR/sd-src"
SD_MODEL_FILE="$SD_MODEL_DIR/sd_xl_base_1.0.safetensors"
SD_BINARY="$SD_BIN_DIR/sd"
SD_REPO_URL="https://github.com/leejet/stable-diffusion.cpp"
SD_MODEL_URL="https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors"

# ─── pretty helpers ─────────────────────────────────────────────────────────
bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
cyan()  { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

confirm() {
  # $1 prompt  $2 default (y/n)
  local prompt="$1" default="${2:-n}" reply
  local hint
  if [[ "$default" == "y" ]]; then hint="[Y/n]"; else hint="[y/N]"; fi
  read -r -p "$prompt $hint " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

bold "Melo — Generation Setup"
echo "Repo:   $REPO_ROOT"
echo "Home:   $HOME_DIR"
echo

# ─── 0. pre-flight: Melo must not be running ────────────────────────────────
if pgrep -f "src/server.js" >/dev/null 2>&1; then
  red "⚠  A Melo server.js process is running."
  echo "   Quit Melo (Cmd+Q) and re-run this script, otherwise the live process"
  echo "   may overwrite state.json while we work."
  if ! confirm "Continue anyway?" "n"; then exit 1; fi
fi

# ─── 1. npm packages ────────────────────────────────────────────────────────
bold "Step 1/3 — npm install pdfkit + exceljs"
if [[ -d "node_modules/pdfkit" && -d "node_modules/exceljs" ]]; then
  green "  already installed — skipping"
else
  if confirm "  Run \`npm install\` now?" "y"; then
    npm install
    green "  npm install done"
  else
    cyan "  skipped — run \`npm install\` manually later"
  fi
fi
echo

# ─── 2. stable-diffusion.cpp ────────────────────────────────────────────────
bold "Step 2/3 — build stable-diffusion.cpp with Metal"
if [[ -x "$SD_BINARY" ]]; then
  green "  binary already present at $SD_BINARY — skipping"
else
  if confirm "  Clone + build stable-diffusion.cpp (~5-15 min on M-series)?" "y"; then
    # Need: git, cmake, clang. Check before starting.
    for tool in git cmake clang; do
      if ! command -v "$tool" >/dev/null 2>&1; then
        red "  missing \`$tool\` — install it first (brew install $tool or Xcode CLI tools)."
        exit 1
      fi
    done

    mkdir -p "$SD_BIN_DIR"
    if [[ ! -d "$SD_SRC_DIR/.git" ]]; then
      cyan "  cloning $SD_REPO_URL"
      git clone --depth 1 --recurse-submodules "$SD_REPO_URL" "$SD_SRC_DIR"
    else
      cyan "  source already cloned — pulling latest"
      (cd "$SD_SRC_DIR" && git pull --ff-only && git submodule update --init --recursive)
    fi

    cyan "  configuring (SD_METAL=ON)"
    cmake -S "$SD_SRC_DIR" -B "$SD_SRC_DIR/build" -DSD_METAL=ON

    cyan "  building (this is the long part)"
    cmake --build "$SD_SRC_DIR/build" -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

    # Copy the built binary into a stable location Melo knows about.
    if [[ -x "$SD_SRC_DIR/build/bin/sd" ]]; then
      cp "$SD_SRC_DIR/build/bin/sd" "$SD_BINARY"
    elif [[ -x "$SD_SRC_DIR/build/sd" ]]; then
      cp "$SD_SRC_DIR/build/sd" "$SD_BINARY"
    else
      red "  build finished but no \`sd\` binary was found — check $SD_SRC_DIR/build/"
      exit 1
    fi
    chmod +x "$SD_BINARY"
    green "  installed $SD_BINARY"
  else
    cyan "  skipped — set sdcppBinary in Melo config if you build it elsewhere"
  fi
fi
echo

# ─── 3. SDXL base 1.0 checkpoint ────────────────────────────────────────────
bold "Step 3/3 — download SDXL base 1.0 (≈6.5 GB)"
mkdir -p "$SD_MODEL_DIR"
if [[ -f "$SD_MODEL_FILE" ]]; then
  SIZE_MB=$(du -m "$SD_MODEL_FILE" | cut -f1)
  if (( SIZE_MB > 6000 )); then
    green "  model already present (${SIZE_MB} MB) — skipping"
  else
    cyan "  partial file detected (${SIZE_MB} MB) — will resume"
    if confirm "  Resume download?" "y"; then
      curl -L -C - -o "$SD_MODEL_FILE" "$SD_MODEL_URL"
    fi
  fi
else
  if confirm "  Download SDXL base 1.0 now (6.5 GB, resumable)?" "y"; then
    curl -L -o "$SD_MODEL_FILE" "$SD_MODEL_URL"
    green "  saved to $SD_MODEL_FILE"
  else
    cyan "  skipped — put the file at:"
    echo "    $SD_MODEL_FILE"
    echo "  or set sdcppModelPath in Melo config."
  fi
fi
echo

# ─── sanity report ──────────────────────────────────────────────────────────
bold "Summary"
[[ -d "node_modules/pdfkit" ]]  && green "  pdfkit installed" || red "  pdfkit MISSING"
[[ -d "node_modules/exceljs" ]] && green "  exceljs installed" || red "  exceljs MISSING"
[[ -x "$SD_BINARY" ]]           && green "  sd.cpp binary: $SD_BINARY" || red "  sd.cpp binary MISSING"
[[ -f "$SD_MODEL_FILE" ]]       && green "  SDXL model:    $SD_MODEL_FILE" || red "  SDXL model MISSING"

echo
bold "Next"
echo "  1. Start Melo (make sure Cmd+Q-ed any running instance first)"
echo "  2. Try:   /tool xlsx  or  /tool pdf structured  or  /tool image generate"
