---

Build a local network traffic monitoring dashboard called **Conduit**. This is a server application that runs on a Linux/Mac machine and exposes a web-based dashboard on a configurable port (default 4200). When you open the dashboard in a browser, you see live network traffic visualized in a clean, data-dense table layout inspired by financial trading terminals.

---

**Core concept**

The app captures real network packets on the machine using whatever packet capture method is most appropriate for the chosen stack. It tracks traffic per port and streams live updates to the frontend via WebSocket. Each port the user wants to monitor gets its own row in the dashboard table.

---

**What each row displays**

Every monitored port gets a row with the following data columns:

- **Port name** — user-configured display name (e.g. "Nginx" or "API Server"), plus the port number shown smaller below it
- **Mini bar chart** — a sparkline-style bar chart showing the last 60 or so packets captured on this port. Each bar represents one packet and the height of the bar is proportional to the packet size in bytes. Bars should animate in from the right and push older bars to the left (like a scrolling ticker). Incoming and outgoing packets can be subtly different colors.
- **IN** — rolling average of incoming packet sizes in bytes (last 30 packets)
- **OUT** — rolling average of outgoing packet sizes in bytes (last 30 packets)
- **Req/s** — requests per second, calculated over a rolling 5-second window
- **Top source** — the IPv4 address that has sent the most packets to this port in the last 30 seconds
- **Total** — total packet count since monitoring started
- **Last seen** — timestamp (HH:MM:SS) of the last packet captured on this port

Rows with recent activity should be visually distinct from idle rows — maybe slightly higher brightness or a subtle left border indicator.

---

**Settings page**

There must be a dedicated settings page reachable from the main dashboard (a button or nav link in the header). On this page the user can:

- See all currently monitored ports in a list
- Add a new port to monitor: input for port number and input for display name
- Remove any existing port
- Reorder ports (drag and drop, or up/down arrows — whatever is simpler)
- Set the dashboard's own port number (requires restart, so just show a note)

Changes to monitored ports should apply immediately without restarting the server. When a port is added, the server starts capturing on it right away and a new row appears in the dashboard. When a port is removed, the row disappears.

Config should be persisted to a `config.json` file so it survives restarts.

---

**Visual design — spend real time on this**

This is the most important part. The UI needs to look like something a developer would actually want to leave open on a second monitor. Take your time. Do not rush the design.

Reference image is provided for layout and information density inspiration — look at how data is organized in rows and columns, how numbers are displayed, how the mini charts look. Do NOT copy the visual style though. The reference is a stock trading terminal with purple/neon aesthetics. NetWatch should feel completely different.

**The aesthetic to aim for:**
- Dark background, but not pure black — something like a very dark warm grey or dark navy, with enough contrast to feel premium rather than flat
- Clean, professional typographic hierarchy. Numbers and IP addresses should use a monospace or semi-monospace font. Labels and headers can use a clean sans-serif. There should be a clear visual difference between data values and labels.
- One primary accent color, used sparingly — for active states, the latest bar in the chart, or highlighted values. Something muted, not saturated. Think a cool steel blue, a dim amber, or a desaturated teal. Not bright cyan, not neon green.
- Subtle table row separators — thin lines or just spacing, not heavy borders
- Numbers that go up should feel different from numbers that go down — use muted green and muted red, not garish ones
- The mini bar charts should feel like they belong in the UI, not like a chart library was dropped in. Keep them pixel-sharp and minimal.
- Column headers should be clean and understated
- No card shadows, no border-radius overload, no gradients on buttons, no emoji anywhere
- The settings page should feel like it belongs in the same app — same fonts, same background, clean form inputs that match the dark theme

The overall feeling should be: Bloomberg Terminal meets a well-designed developer CLI tool turned into a web UI. Data-first. No decoration for the sake of decoration. Confident and quiet.

---

**Technical requirements**

- Needs to run with elevated permissions (sudo or equivalent) to capture raw packets — make this clear in the README
- WebSocket connection from frontend to backend for live updates — the frontend should reconnect automatically if the connection drops
- Frontend should handle the case where a port has no traffic yet gracefully — show the row with zeroed/empty state, not an error
- If packet capture fails or permissions are wrong, show a clear error in the UI rather than silently doing nothing
- The dashboard should work in a modern browser with no build step required for the frontend — plain HTML/CSS/JS or a simple served bundle is fine

---

**File structure to aim for**

```
netwatch/
  server.js (or equivalent entry point)
  config.json
  config.example.json
  public/
    index.html
    (any JS/CSS if split out)
  README.md
  package.json (or equivalent)
```

---

**README must include:**
- What it is, one paragraph
- Prerequisites (Node version, libpcap or equivalent, sudo)
- Install steps
- How to run
- How to configure ports (both via config.json and via the settings page)
- A note on why sudo is needed

---

Do not start coding until you have a clear picture of the full implementation. Think through the packet capture approach, the WebSocket data format, and the frontend rendering strategy before writing any code. Prioritize correctness and design quality over speed.

---
