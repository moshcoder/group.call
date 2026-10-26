#!/bin/sh
# deb post-install: put `groupcall` on PATH, running the CLI bundled in the app
# with Electron as its Node (ELECTRON_RUN_AS_NODE), so no system Node is needed.
cat > /usr/local/bin/groupcall <<'SHIM'
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "/opt/group.call/group-call" "/opt/group.call/resources/cli/bin.mjs" "$@"
SHIM
chmod 755 /usr/local/bin/groupcall
# Ubuntu 24.04+ restricts unprivileged user namespaces; Electron needs its sandbox helper setuid.
[ -f /opt/group.call/chrome-sandbox ] && chmod 4755 /opt/group.call/chrome-sandbox || true
