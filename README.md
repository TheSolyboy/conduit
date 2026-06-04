# Conduit

A local network traffic monitoring dashboard. Conduit captures live packets on a Linux/macOS machine, attributes them to user-configured ports, and streams the result to a dark, data-dense web dashboard inspired by trading terminals — a quiet thing you leave open on a second monitor.

## Prerequisites

- **Node.js ≥ 18**
- **libpcap** development headers (the `cap` native addon links against them)
  - Debian / Ubuntu: `sudo apt install libpcap-dev`
  - Fedora / RHEL: `sudo dnf install libpcap-devel`
  - macOS: ships with the system, no install needed (Xcode command-line tools required for the native build: `xcode-select --install`)
- **Build toolchain** for `node-gyp`: `python3`, `make`, a C compiler. On Debian/Ubuntu: `sudo apt install build-essential`.
- **Elevated privileges** to capture raw packets — see below.

## Install

```sh
git clone https://github.com/<you>/conduit.git
cd conduit
npm install
```

`npm install` builds a small native binding via `node-gyp`. If the build fails the most common cause is missing `libpcap-dev` or `build-essential`.

## Run

```sh
sudo node server.js
```

Then open <http://localhost:4200>.

### Avoiding sudo (Linux)

If you'd rather not run as root, grant the Node binary the capabilities it needs:

```sh
sudo setcap cap_net_raw,cap_net_admin=eip $(readlink -f $(which node))
```

Then start with `CONDUIT_TRY_UNPRIV=1 node server.js`. The env-var opts in to attempting packet capture as a non-root user — without it, Conduit refuses up-front (because the underlying libpcap binding can crash on a failed open).

This affects *every* Node process for that binary — undo with `sudo setcap -r $(readlink -f $(which node))`.

### macOS

You either run with `sudo`, or change the `/dev/bpf*` device permissions so your user can open them (e.g. via [ChmodBPF](http://wiki.wireshark.org/CaptureSetup/macOS)).

## Configuration

Conduit reads `config.json` at the repository root. If the file is missing it writes a default one.

```json
{
  "dashboardPort": 4200,
  "interface": null,
  "ports": [
    { "port": 22,  "name": "SSH" },
    { "port": 80,  "name": "HTTP" },
    { "port": 443, "name": "HTTPS" }
  ]
}
```

- `dashboardPort` — the HTTP port the web UI listens on. Requires a restart to take effect.
- `interface` — `null` for auto-detect (the first non-loopback device libpcap finds), or a name like `"eth0"`, `"en0"`, `"wlan0"`.
- `ports[]` — the list of ports to monitor. Each row in the dashboard.

### Editing ports from the dashboard

Click **SETTINGS** in the header. From there you can add, remove, rename and reorder ports. Changes apply immediately — the row appears or disappears in the dashboard without a restart. The config file is rewritten atomically each time.

Changing the dashboard port or the capture interface from this page persists to disk but does not relocate the running listener — restart the server for those to take effect.

## Why sudo / capabilities

Conduit uses libpcap to read raw packets off a network interface. That's a privileged operation on every modern OS — without it you can only see traffic addressed to your process. We need to see *all* packets on the chosen interface so we can attribute them to monitored ports. Hence the elevated permissions.

The dashboard itself is plain HTTP on the chosen port. The capture loop only reads packet headers (lengths, addresses, ports) and a small ring buffer per port — payloads are never inspected, stored or logged.

## Layout

```
conduit/
  server.js              — HTTP + WebSocket + capture loop
  config.json            — runtime configuration (created on first run)
  config.example.json    — reference for the format
  public/
    index.html
    style.css
    app.js
  README.md
  package.json
```
