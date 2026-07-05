# Mobile testing

This plugin declares `"isDesktopOnly": false`, so release confidence needs two
layers:

1. Desktop-run automation that catches mobile-incompatible code paths and
   phone-width UI regressions.
2. A real Obsidian Mobile smoke pass before publishing meaningful mobile-facing
   changes.

## Automated local gates

Run these before release work:

```bash
npm run verify:mobile
npm run test:e2e:mobile
```

`verify:mobile` is a static and bundle-level gate. It fails if source code adds
unallowlisted Node/Electron APIs, if the release bundle contains direct
desktop-only requires, or if the README stops documenting the current
mobile/desktop auth and networking behavior:

- MCP OAuth sign-in uses a localhost callback on desktop and an
  `obsidian://agentic-chat-mcp-oauth` callback on mobile when the provider
  supports app redirects. Localhost-only providers still require desktop.
- Plugin-owned HTTP proxy settings use desktop Node networking when configured.

`test:e2e:mobile` builds the e2e bundle, boots Obsidian Desktop through the
existing WDIO harness, enables `wdio-obsidian-service` mobile emulation, and
applies Chrome phone-sized device metrics. This catches layout/touch-path
regressions in the chat composer, settings tabs, approval modal, session list,
and long assistant messages. It is not a substitute for real Obsidian Mobile
because the runtime is still Electron.

`npm run build` also runs `verify:mobile`, so CI and semantic-release block on
the mobile compatibility gate.

## Android device or emulator smoke

Prerequisites:

- Android device or emulator with Obsidian installed.
- USB debugging enabled and `adb devices` showing the target.
- A test vault already opened once in Obsidian Mobile.

Build and install the local plugin assets into that vault:

```bash
npm run build
npm run install:android -- /sdcard/Documents/MyTestVault
```

If your vault lives elsewhere, pass that vault root instead. The script copies
`manifest.json`, `main.js`, and `styles.css` to:

```text
<vault>/.obsidian/plugins/agentic-chat/
```

Then run this smoke checklist in Obsidian Mobile:

- Enable **Agentic Chat** from Community plugins.
- Open the Agentic Chat sidebar/ribbon entry.
- Open settings and switch through Models, Approval, Web, MCP, Notifications,
  and Resources.
- Save a provider API key and model, then reopen settings and confirm the values
  persist.
- Send a no-tool prompt through a real provider or local gateway.
- Run `/help`, `/status`, `/sessions`, and `/new`.
- Ask for a vault read, then ask for a write/edit and confirm the approval modal
  is readable and touchable.
- Confirm session history persists after closing and reopening Obsidian.
- Confirm Web and MCP are off by default on a fresh install.
- Leave plugin proxy fields empty on mobile. Use Android/VPN/network-level proxy
  routing if the device needs a proxy.
- For MCP OAuth on mobile, use a provider/server that accepts the
  `obsidian://agentic-chat-mcp-oauth` redirect. If it only accepts localhost
  redirects, authenticate on desktop first or use bearer/static-header auth.

Record the device/emulator, Android version, Obsidian version, plugin version,
the smoke date, and any failures in the release notes or PR before publishing.
For mobile-facing changes, a PR/release without this entry is not considered
fully mobile-validated even when `test:e2e:mobile` passes.

## iOS smoke

iOS plugin file installation and automation are more constrained from this Linux
workspace. Treat iOS as a manual/macOS-backed smoke pass:

- Sync or manually copy the built plugin assets into the test vault's
  `.obsidian/plugins/agentic-chat/` folder.
- Run the same smoke checklist as Android.
- Record the iOS version, Obsidian version, plugin version, smoke date, and
  failures in the release notes or PR.

## What desktop cannot prove

The desktop mobile viewport run cannot prove:

- Obsidian Mobile's actual plugin loader behavior.
- Availability of Web APIs inside the mobile WebView.
- Secret storage behavior on Android/iOS.
- OS keyboard, touch selection, and mobile file-provider edge cases.
- Device/VPN/proxy routing.

For those, use the real-device checklist.
