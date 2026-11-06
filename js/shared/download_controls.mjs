// Color variants for the addon pilot. The main pack's shared controls stay intact.
import { compactAction } from "./panel_controls.mjs";

export function downloadAction(label, title, tone = "neutral") {
  ensureDownloadControls();
  const button = compactAction(label, title);
  button.classList.add("abmd-control");
  button.dataset.tone = tone;
  button.setAttribute("aria-label", title || label);
  return button;
}

export function setActionLabel(button, label, icon = "") {
  if (button.dataset.label === label && button.dataset.icon === icon) return;
  button.dataset.label = label; button.dataset.icon = icon;
  button.replaceChildren();
  if (icon) {
    const paths = {
      up: "M8 13V3M3 8l5-5 5 5",
      down: "M8 3v10M3 8l5 5 5-5",
      download: "M8 2v8M4.5 6.5 8 10l3.5-3.5M3 11v3h10v-3",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false"); svg.classList.add("abmd-action-icon");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[icon]); svg.append(path); button.append(svg);
  }
  if (label) {const text = document.createElement("span"); text.textContent = label; button.append(text);}
}

export function ensureDownloadControls() {
  if (document.getElementById("ausboss-download-controls")) return;
  const style = document.createElement("style");
  style.id = "ausboss-download-controls";
  style.textContent = `
.ausboss-compact-action.abmd-control{--abmd-fill:#293538;--abmd-line:#47585b;--abmd-ink:#d8e2e0;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:27px;padding:0 10px;border-radius:5px;border-color:var(--abmd-line);background:var(--abmd-fill);color:var(--abmd-ink);font:600 11px/1 system-ui,sans-serif;transition:filter .12s,border-color .12s}
.ausboss-compact-action.abmd-control[data-tone=primary]{--abmd-fill:#00b4aa;--abmd-line:#00b4aa;--abmd-ink:#041a1c}
.ausboss-compact-action.abmd-control[data-tone=success]{--abmd-fill:#263c36;--abmd-line:#45645a;--abmd-ink:#6fc0aa}
.ausboss-compact-action.abmd-control[data-tone=danger]{--abmd-fill:#3d292e;--abmd-line:#71434d;--abmd-ink:#ff9caa}
.ausboss-compact-action.abmd-control:hover:enabled{background:var(--abmd-fill);border-color:var(--abmd-line);color:var(--abmd-ink);filter:brightness(1.2)}
.ausboss-compact-action.abmd-control:focus-visible{outline:2px solid #00b4aa;outline-offset:2px}
.ausboss-compact-action.abmd-control:disabled{opacity:.4;filter:none;cursor:default}
.ausboss-compact-action.abmd-control[data-tone=success]:disabled{opacity:1}
.ausboss-compact-action.abmd-control.abmd-enabled{width:35px;padding:0;color:#91a6a9;background:#222e30;border-color:#47585b}
.ausboss-compact-action.abmd-control.abmd-enabled[aria-pressed=true]{background:#1d3838;border-color:#3a7571;color:#9bd5cd}
.ausboss-compact-action.abmd-control .abmd-action-icon{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2.25;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.ausboss-compact-action.abmd-control.abmd-icon-only{width:28px;padding:0}
.ausboss-compact-action.abmd-control.abmd-icon-only:disabled{opacity:.55}
.ausboss-compact-action.abmd-control[hidden]{display:none}
`;
  document.head.append(style);
}
