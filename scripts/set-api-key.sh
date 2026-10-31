#!/usr/bin/env bash
# Store the Anthropic API key in config/secrets.env (mode 600) without echoing it.
set -euo pipefail
F=/home/hussain/minecraft-server/config/secrets.env
umask 077
read -r -s -p "Paste Anthropic API key (input hidden): " KEY; echo
[[ "$KEY" == sk-ant-* ]] || { echo "That does not look like an Anthropic key (sk-ant-...). Nothing changed."; exit 1; }
tmp=$(mktemp "$F.XXXX")
grep -v '^ANTHROPIC_API_KEY=' "$F" > "$tmp" || true
printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" >> "$tmp"
chmod 600 "$tmp"; mv "$tmp" "$F"
echo "Saved to $F (permissions: $(stat -c %a "$F")). Restart agents: systemctl --user restart mc-agents"
