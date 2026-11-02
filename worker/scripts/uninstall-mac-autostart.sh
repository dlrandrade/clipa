#!/bin/bash
# Desliga o início automático do worker da Clipa.
set -euo pipefail
LABEL="com.clipa.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Início automático desligado."
