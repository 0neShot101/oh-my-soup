# @oh-my-soup/collab-web

Web client for [oms collab sessions](../../docs/collab.md). Paste a `/collab` link into the browser and you get the same live session guests see in the TUI: streaming transcript, tool-call cards, subagent panel with live transcripts, and a composer that prompts (or interrupts) the host agent.

## Quick start

```sh
# dev server (Bun HTML dev server with HMR) — http://localhost:3000
bun run dev

# offline demo: local relay + scripted mock host; prints a ws://localhost link
bun run mock-host
```

Host a session from any oms instance (`/collab`, or `/collab ws://localhost:7466` to use the mock relay), then paste the printed link into the connect screen. Deep links work too: `http://localhost:3000/#<roomId>.<key>` auto-connects on load.

## Build & deploy

```sh
bun run build   # static site in dist/
```

`dist/` contains the static browser app and a self-contained encrypted `share.html` viewer. JS/CSS bundles are content-hashed; public assets are copied alongside them. Runtime requirements:

- **Authenticated encryption**: WebCrypto is preferred when available. On trusted VPN HTTP origins without `crypto.subtle`, a bundled AES-256-GCM implementation uses the same wire format and authentication tag. Secure `crypto.getRandomValues` is still required; encryption is never disabled, and authentication failures never trigger a different backend.
- **Relay reachability**: HTTP browser pages can use an explicit `ws://` VPN relay. HTTPS pages normally block remote `ws://` as mixed content, so pair HTTPS with WSS. The default relay is `wss://my.omp.sh`; bare invitations resolve against it and scheme-less custom relay URLs default to WSS.

The room key never leaves the URL fragment — it is not sent to the relay or any server.

Native and browser clients can use `ws://10.66.66.8` over a trusted VPN; session payloads remain AES-256-GCM encrypted. Serve this app at `http://10.66.66.8` and set `collab.webUrl` to that URL to advertise browser invitations. HTTP relies on the VPN for transport integrity and trusted delivery of application JavaScript; prefer HTTPS/WSS outside that trust boundary. Relay base paths are preserved independently from the configured browser UI path. Custom relays do not imply a browser UI at their root. A separate HTTPS UI does not upgrade an invitation's WS transport to WSS.

## Large sessions

The browser requests a recent history page instead of downloading the complete session. Pages and retained transcript windows are bounded by 100 entries and 128 KiB of serialized UTF-8 data; the existing oversized-entry policy allows one capped entry to exceed that soft byte limit. Snapshot chunks normally fit within 64 KiB.

**Older**, **Newer**, and **Latest** replace the displayed page. Older history stays on the host and remains accessible; browsing does not grow an unbounded transcript or DOM. Live arrivals are retained in a separate bounded tail while reading history. Tool results whose calls are outside the current page render independently.

Assistant updates are coalesced for 50 ms before serialization. Text/thinking appends travel as ordered content patches rather than repeated complete partial messages; full baselines support mid-turn joins and corrections. Missing or out-of-order patches produce a visible rejoin error rather than silently losing text.

This requires collab protocol v4 on both ends. Restart an already-running host with `/restart`, run `/collab` again, and reopen its new invitation after updating. Native TUI guests still receive the complete replica, not browser history pages.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-soup/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<oms-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, overlay in exports).
- `scripts/` — `local-relay.ts` (content-blind relay on `Bun.serve`), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `build-tool-views.ts` (bundles `src/tool-render/` + React into `packages/coding-agent/src/export/html/tool-views.generated.js` for self-contained exports).

The package is intentionally standalone — no dependency on `@oh-my-soup/pi-coding-agent` at runtime or type level. Wire-shape drift is prevented by consuming the same `@oh-my-soup/pi-wire` contracts as the host, with sealed-frame interop still covered by `test/codec.test.ts`.
