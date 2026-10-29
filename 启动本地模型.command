#!/bin/zsh
cd "$(dirname "$0")/app" || exit 1
exec node local-start.mjs
