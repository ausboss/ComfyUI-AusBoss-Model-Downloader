// The downloader's buttons: the pack's compact button in the tones a download needs.
// Every colour comes from the shared palette, so they follow the main pack's look.
import { compactAction } from "./panel_controls.mjs";
import { CONTROL_HEIGHT, FONT_UI, RADIUS_CONTROL, THEME as T } from "./theme.mjs";

const ICONS = {
  up: "M8 13V3M3 8l5-5 5 5",
  down: "M8 3v10M3 8l5 5 5-5",
  download: "M8 2v8M4.5 6.5 8 10l3.5-3.5M3 11v3h10v-3",
  check: "M3 8.5l3.2 3.2L13 4.8",
  close: "M4 4l8 8M12 4l-8 8",
  chevron: "M6 3.5 10.5 8 6 12.5",
  refresh: "M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3",
};

export function actionIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false"); svg.classList.add("abmd-action-icon");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", ICONS[name]); svg.append(path);
  return svg;
}

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
  if (icon) button.append(actionIcon(icon));
  if (label) {const text = document.createElement("span"); text.textContent = label; button.append(text);}
}

export function ensureDownloadControls() {
  if (document.getElementById("ausboss-download-controls")) return;
  const style = document.createElement("style");
  style.id = "ausboss-download-controls";
  style.textContent = `
.ausboss-compact-action.abmd-control{--abmd-fill:${T.fill};--abmd-hover:${T.fillHover};--abmd-ink:${T.inkSoft};display:inline-flex;align-items:center;justify-content:center;gap:5px;height:${CONTROL_HEIGHT}px;padding:0 10px;border:1px solid transparent;border-radius:${RADIUS_CONTROL}px;background:var(--abmd-fill);color:var(--abmd-ink);font:600 11px/1 ${FONT_UI}}
.ausboss-compact-action.abmd-control[data-tone=primary]{--abmd-fill:${T.brand};--abmd-hover:${T.brand};--abmd-ink:${T.onBrand};font-weight:700}
.ausboss-compact-action.abmd-control[data-tone=success]{--abmd-fill:${T.brandSoft};--abmd-hover:${T.brandSoftHover};--abmd-ink:${T.brandInk}}
.ausboss-compact-action.abmd-control[data-tone=danger]{--abmd-fill:${T.dangerSoft};--abmd-hover:${T.dangerSoft};--abmd-ink:${T.dangerInk}}
.ausboss-compact-action.abmd-control[data-tone=quiet]{--abmd-fill:transparent;--abmd-hover:${T.dangerSoft};--abmd-ink:${T.label}}
.ausboss-compact-action.abmd-control:hover:enabled{background:var(--abmd-hover);color:var(--abmd-ink)}
.ausboss-compact-action.abmd-control[data-tone=neutral]:hover:enabled{color:${T.inkHover}}
.ausboss-compact-action.abmd-control[data-tone=primary]:hover:enabled,.ausboss-compact-action.abmd-control[data-tone=danger]:hover:enabled{filter:brightness(1.12)}
.ausboss-compact-action.abmd-control[data-tone=quiet]:hover:enabled{color:${T.dangerInk}}
.ausboss-compact-action.abmd-control:focus-visible{outline:2px solid ${T.brand};outline-offset:1px}
.ausboss-compact-action.abmd-control:disabled{opacity:.45;filter:none;cursor:default}
.ausboss-compact-action.abmd-control[data-tone=success]:disabled{opacity:1}
.ausboss-compact-action.abmd-control .abmd-action-icon{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.ausboss-compact-action.abmd-control.abmd-icon-only{width:${CONTROL_HEIGHT}px;padding:0}
.ausboss-compact-action.abmd-control[hidden]{display:none}
`;
  document.head.append(style);
}
