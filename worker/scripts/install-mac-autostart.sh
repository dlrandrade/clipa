#!/bin/bash
# Liga o worker da Clipa automaticamente quando você entra no Mac,
# e religa sozinho se ele cair. Rode uma vez: npm run autostart
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.clipa.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/clipa-worker.log"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node não encontrado. Rode: brew install node"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg não encontrado. Rode: brew install ffmpeg"; exit 1; }
[ -f "$DIR/.env" ] || { echo "Falta o arquivo .env em $DIR (copie de .env.example e preencha)."; exit 1; }

NODE_DIR="$(dirname "$NODE")"
PATH_VALUE="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PLIST_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file-if-exists=.env</string>
    <string>src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH_VALUE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>"

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "$PLIST_CONTENT"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
echo "$PLIST_CONTENT" > "$PLIST"

UIDN="$(id -u)"
launchctl bootout "gui/$UIDN/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UIDN" "$PLIST"
launchctl kickstart -k "gui/$UIDN/$LABEL"

echo "Pronto! O worker agora liga sozinho com o Mac."
echo "Ver o que ele está fazendo:  npm run logs"
echo "Desligar o automático:       npm run autostart:off"
