#!/usr/bin/env bash
# Fabrik's bootstrap script. The Operator runs Setup with it, in their own
# terminal, from the root of the Product repo's clone:
#   curl -fsSL https://raw.githubusercontent.com/jrey8343/fabrik/main/setup.sh | bash -s -- [release] [setup's flags]
# It checks for Node 24 and gh, finds the release (Fabrik's latest unless one
# is named, as an exact tag), downloads it into a temporary folder, runs that
# release's setup program with every other argument, and deletes the folder
# whatever the outcome. It does nothing else: everything that acts is in the
# release, so the release's pin works as before, and this script barely
# changes between releases. Every step is inside fabrik_setup, called on the
# last line, so bash has read the whole script before it runs any of it.
set -euo pipefail

RELEASES="https://github.com/jrey8343/fabrik/releases"
# An exact release tag, as the caller workflow must pin one (src/kit/caller.ts).
EXACT_RELEASE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

stop() {
  printf '%s\n' "$1" >&2
  exit 1
}

fabrik_setup() {
  local release="" node_version gh_said
  # The release comes first, when it's named: every flag is setup's.
  if [[ $# -gt 0 && $1 != -* ]]; then
    release=$1
    shift
  fi

  command -v node >/dev/null 2>&1 ||
    stop "Setup needs Node 24 or later, and node isn't installed. Install Node 24, then run setup again."
  node_version=$(node --version 2>/dev/null || true)
  node_version=${node_version#v}
  if [[ ! ${node_version%%.*} =~ ^[0-9]+$ ]] || ((${node_version%%.*} < 24)); then
    stop "Setup needs Node 24 or later, and this is Node $node_version. Install Node 24, then run setup again."
  fi
  command -v gh >/dev/null 2>&1 ||
    stop "Setup needs gh, GitHub's CLI, and it isn't installed. Install it from https://cli.github.com, then run setup again."

  # Deleted however this ends: a failure, a Ctrl-C or a closed terminal included.
  FABRIK_SETUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fabrik-setup.XXXXXX")
  trap 'rm -rf "$FABRIK_SETUP_DIR"' EXIT
  local kit="$FABRIK_SETUP_DIR/fabrik"

  if [[ -z $release ]]; then
    release=$(gh release view --repo jrey8343/fabrik --json tagName --jq .tagName 2>"$FABRIK_SETUP_DIR/gh-said") || {
      gh_said=$(<"$FABRIK_SETUP_DIR/gh-said")
      stop "gh couldn't find Fabrik's latest release (${gh_said%%$'\n'*}). Sign in with gh auth login --scopes workflow, or name the release, then run setup again."
    }
  fi
  [[ $release =~ $EXACT_RELEASE ]] ||
    stop "$release isn't an exact Fabrik release tag such as v1.2.3. Name one from $RELEASES, or leave it out for the latest."

  mkdir "$kit"
  curl -fsSL "https://codeload.github.com/jrey8343/fabrik/tar.gz/refs/tags/$release" 2>/dev/null |
    tar -xzf - -C "$kit" --strip-components=1 2>/dev/null ||
    stop "Downloading Fabrik $release failed. Check it's a release at $RELEASES, then run setup again."
  printf 'Running Setup from Fabrik %s.\n' "$release"

  # Piped into bash, stdin is this script, so setup reads the terminal instead.
  # Without one it asks nothing, and stops at its plan.
  if { : </dev/tty; } 2>/dev/null; then
    node "$kit/src/setup/main.ts" . "$release" "$@" </dev/tty
  else
    node "$kit/src/setup/main.ts" . "$release" "$@" </dev/null
  fi
}

fabrik_setup "$@"
