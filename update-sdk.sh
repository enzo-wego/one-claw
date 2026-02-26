#!/bin/bash
# Updates @anthropic-ai/claude-agent-sdk to match local Claude Code version
# Claude Code 2.1.X → SDK 0.2.X

set -e

CLAUDE_VERSION=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ -z "$CLAUDE_VERSION" ]; then
  echo "Error: could not detect Claude Code version"
  exit 1
fi

PATCH=$(echo "$CLAUDE_VERSION" | cut -d. -f3)
SDK_TARGET="0.2.$PATCH"

# Verify the SDK version exists on npm
if ! npm view "@anthropic-ai/claude-agent-sdk@$SDK_TARGET" version &>/dev/null; then
  echo "SDK v$SDK_TARGET not found on npm (Claude Code is v$CLAUDE_VERSION)"
  echo "Check: https://github.com/anthropics/claude-agent-sdk-typescript/releases"
  exit 1
fi

CURRENT=$(node -e "console.log(require('./package.json').dependencies['@anthropic-ai/claude-agent-sdk'])" 2>/dev/null)
echo "Claude Code:  v$CLAUDE_VERSION"
echo "SDK current:  $CURRENT"
echo "SDK target:   ^$SDK_TARGET"

if [ "$CURRENT" = "^$SDK_TARGET" ]; then
  echo "Already up to date."
  exit 0
fi

sed -i '' "s|\"@anthropic-ai/claude-agent-sdk\": \"[^\"]*\"|\"@anthropic-ai/claude-agent-sdk\": \"^$SDK_TARGET\"|" package.json
npm install
echo "Updated to ^$SDK_TARGET"
