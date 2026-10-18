# S-019-3 — spellcheck network traffic (manual procedure)

Spike register S-019-3 (ADR-019 D1; NFR-SEC-11): does Electron 44 download spellcheck dictionaries when
`spellcheck: true`? And if the download URL cannot be reached, does the composer spellcheck still work offline? The
testing strategy (`17` §4) asks for a manual run with a traffic capture. The automated half runs in the packaging
spike lane (`spellcheck.mjs`, `docs/spikes-lane.md`).

## Automated half (CI)

- `spellcheck.mjs probe` runs `spellcheckProbe.cjs` with the repository's Electron, which is the version the product
  ships. It runs four modes: `off`, `on`, `on-unreachable` (download URL set to a closed local port) and
  `cached-unreachable` (the `on` profile, now with no reachable URL). It records the session requests, the dictionary
  download events, a Chromium net log, and whether a right-click on a misspelled word reports it.
- `spellcheck.mjs packaged` starts the packaged product with a net log and lists every host it contacted. Today the
  product runs with spellcheck off, the interim value of ADR-019 item 1.

## Manual half (each OS, for the record)

1. Use a machine or VM with no DwarfAI data that matters, connected to a network you can capture.
2. Start a capture that shows DNS and TLS SNI. Use Wireshark, or on Windows `pktmon start --capture`, or on macOS and
   Linux `tcpdump -i any -w s0193.pcap port 53 or port 443`.
3. Run `node spikes/S-019-3/spellcheck.mjs probe --out <dir>` from a checkout with `pnpm install` done. On Linux, run
   it in a desktop session, not under Xvfb.
4. Stop the capture. In it, find the name lookups and TLS server names around each probe mode. Chromium fetches
   dictionaries from `redirector.gvt1.com` (`/edgedl/chrome/dict/*.bdic`).
5. Disconnect the network and run step 3 again. This records the offline behaviour of each mode.
6. In `spike-results/S-019-3.md`, record per OS: OS version, Electron version, the date, whether the `on` mode
   contacted a dictionary host, whether a misspelled word was still reported in `on-unreachable`,
   `cached-unreachable` and offline, and the decision for the composer setting. Scrub the capture with the
   `privacy-guard` skill before any of it goes into `spike-results/S-019-3/`.

Expected per-OS differences to check, not assume: macOS uses the system spellchecker, and Windows uses the system
spellchecker unless Electron is told otherwise. Linux uses Hunspell dictionaries that Chromium downloads.
