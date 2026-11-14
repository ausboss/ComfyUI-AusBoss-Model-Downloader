import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { chainCallback, keepDomWidgetWidthAuto, notifyAusbossChange, showToast } from "../shared/index.mjs";
import { actionIcon, downloadAction, ensureDownloadControls, setActionLabel } from "../shared/download_controls.mjs";
import { fillNodeHeight, WIDGET_FRAME } from "../shared/panel_layout.mjs";
import { panelKeepsWheel } from "../shared/canvas_passthrough.mjs";
import { CONTROL_HEIGHT, FONT_UI, RADIUS_CARD, RADIUS_CONTROL, RADIUS_XS, SELECT_CHEVRON, THEME as T } from "../shared/theme.mjs";
import { activeJob, cleanList, cleanRow, cleanUrl, eachAtOnce, moveItem, nodeModels, noteModel, rowKey, rowStatus, sizeText, statusText, wheelPixels, wheelScrollsList } from "../shared/models.mjs";

const TYPE = "AUSBOSS_NODES_ModelDownloader";
const PROPERTY = "ausboss_models";
const BASE = "/ausboss/model-downloader";
// Rows checked together; the server runs three transfers at once too, and queues the rest.
const AT_ONCE = 3;
const ROW_DRAG = "application/x-ausboss-model-row";
// The narrowest the node goes: every column still shows, and a name keeps room to be read.
const MIN_WIDTH = 600;
const jobs = new Map(), sizes = new Map(), listeners = new Set();
let folders = [], keyStatus = {}, keySources = {}, timer = null, polling = false;
const emit = () => { for (const fn of listeners) fn(); };
const recentToasts = new Map();
const fail = (error) => {
  // "Download missing" can hit the same problem on every row: say it once.
  const detail = error?.message || String(error), now = Date.now();
  if (now - (recentToasts.get(detail) || 0) < 5000) return;
  recentToasts.set(detail, now);
  showToast({severity: "error", summary: "Model Downloader", detail});
};

async function request(path, body) {
  const response = await api.fetchApi(BASE + path, body === undefined ? {} : {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); }
  catch {
    const detail = response.status === 404
      ? "The downloader is not loaded on the server. Restart ComfyUI, then refresh this page."
      : `The ComfyUI server refused the request (HTTP ${response.status}). Check the ComfyUI console.`;
    throw Object.assign(new Error(detail), {state: "error"});
  }
  if (!response.ok || result.error) throw Object.assign(new Error(result.error || "The request failed."), {state: result.state});
  return result;
}
function takeKeys(info) { keyStatus = info.keys || {}; keySources = info.key_sources || {}; }
const infoReady = request("/info").then(info => { folders = info.folders; takeKeys(info); }).catch(fail);
function schedulePoll() {
  if (!timer && !polling && [...jobs.values()].some(activeJob)) timer = setTimeout(poll, 800);
}
async function poll() {
  timer = null; polling = true;
  let finished = false;
  for (const [key, job] of jobs) if (activeJob(job) && job.id) {
    try {
      const next = await request(`/jobs/${job.id}`);
      jobs.set(key, next); finished ||= next.state === "installed";
    } catch (error) { jobs.set(key, {state: "error", message: error.message}); }
  }
  polling = false; emit(); schedulePoll();
  if (finished) {
    // New files show up in loader lists without pressing R.
    try { await app.refreshComboInNodes?.(); } catch { /* the lists refresh on the next R */ }
    // The pack owns installed-file matching and its "Use it" loader repair.
    for (const node of graphNodes()) if (node.type === "AUSBOSS_NODES_WorkflowNote") node.refreshComboInNode?.();
  }
}
async function check(row) {
  if (!row.url || !row.folder) return;
  const key = rowKey(row);
  if (activeJob(jobs.get(key))) return;
  jobs.set(key, {state: "checking"}); emit();
  try { jobs.set(key, await request("/check", cleanRow(row))); schedulePoll(); }
  catch (error) { jobs.set(key, {state: error.state || "error", message: error.message}); }
  emit();
}
async function download(row) {
  const key = rowKey(row);
  if (activeJob(jobs.get(key))) return;
  jobs.set(key, {state: "queued", message: "Starting"}); emit();
  try { jobs.set(key, await request("/download", cleanRow(row))); schedulePoll(); }
  catch (error) { jobs.set(key, {state: error.state || "error", message: error.message}); fail(error); }
  emit();
}
function graphNodes(graph = app.graph, seen = new Set()) {
  if (!graph || seen.has(graph)) return [];
  seen.add(graph);
  return (graph._nodes || []).flatMap(node => [node, ...graphNodes(node.subgraph, seen)]);
}
function el(tag, cls = "", text = "") {
  const item = document.createElement(tag); item.className = cls; item.textContent = text; return item;
}
function input(placeholder, value = "", type = "text") {
  const item = el("input"); item.type = type; item.placeholder = placeholder; item.value = value;
  item.setAttribute("aria-label", placeholder); return item;
}
function action(label, title, run, tone = "neutral", icon = "") {
  const button = downloadAction(label, title, tone);
  if (icon) setActionLabel(button, label, icon);
  button.addEventListener("click", () => Promise.resolve().then(run).catch(fail)); return button;
}
function applyBrandSurface(node) {
  // Migrate the pilot's default pair; preserve explicit color choices.
  if (!node.color || node.color.toLowerCase() === "#363c4a") node.color = "#14424d";
  if (!node.bgcolor || node.bgcolor.toLowerCase() === "#1d2027") node.bgcolor = "#161f21";
}
// One row of the list: grip, name, folder, status, size, the row's button, remove.
// The heading uses the same columns, so every status, size and button lines up.
const COLUMNS = "12px minmax(0,1fr) 116px 80px 58px 88px 26px";
function gripIcon() {
  const dots = [2, 7, 12].flatMap(y => [2, 6].map(x => `<circle cx="${x}" cy="${y}" r="1.3"/>`));
  const box = el("span", "abmd-grip");
  box.innerHTML = `<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">${dots.join("")}</svg>`;
  return box;
}
function css() {
  ensureDownloadControls();
  if (document.getElementById("ausboss-downloader-style")) return;
  const style = el("style"); style.id = "ausboss-downloader-style";
  const R = ".ausboss-downloader", H = CONTROL_HEIGHT;
  style.textContent = `
${R}{box-sizing:border-box;width:100%;height:100%;padding:8px;display:flex;flex-direction:column;gap:8px;color:${T.inkSoft};background:${T.card};border-radius:${RADIUS_CARD}px;font:12px/1.3 ${FONT_UI};overflow:hidden}
${R} *{box-sizing:border-box}
${R}:focus{outline:none}
${R} .abmd-toolbar{display:flex;gap:6px;align-items:center;flex:none}
${R} .abmd-title{font:600 10px/1 ${FONT_UI};letter-spacing:.1em;text-transform:uppercase;color:${T.faint};user-select:none}
${R} .abmd-hint{font:400 10px/1.3 ${FONT_UI};color:${T.faint}}
${R} .abmd-label{flex:none;font:400 11px/1 ${FONT_UI};color:${T.label};white-space:nowrap}
${R} .abmd-spacer{flex:1}
${R} input,${R} select{width:100%;min-width:0;height:${H}px;border:1px solid transparent;border-radius:${RADIUS_CONTROL}px;background:${T.fill};color:${T.ink};padding:0 8px;font:12px ${FONT_UI};outline:none;color-scheme:dark}
${R} select{appearance:none;-webkit-appearance:none;padding-right:24px;background:${T.fill} ${SELECT_CHEVRON} no-repeat right 9px center;cursor:pointer;text-overflow:ellipsis}
${R} select:hover{background-color:${T.fillHover}}
${R} input::placeholder{color:${T.faint}}
${R} input:focus{border-color:${T.brand}}
${R} select:focus-visible{outline:2px solid ${T.brand};outline-offset:1px}
${R} .abmd-listbox{position:relative;flex:1;min-height:96px}
${R} .abmd-list{position:absolute;inset:0;overflow-y:auto;overscroll-behavior:contain}
${R} .abmd-list::-webkit-scrollbar{width:6px}
${R} .abmd-list::-webkit-scrollbar-track{background:transparent}
${R} .abmd-list::-webkit-scrollbar-thumb{background:${T.fill};border-radius:3px}
${R} .abmd-list::-webkit-scrollbar-thumb:hover{background:${T.fillHover}}
@supports not selector(::-webkit-scrollbar){${R} .abmd-list{scrollbar-width:thin;scrollbar-color:${T.fill} transparent}}
${R} .abmd-head,${R} .abmd-line{display:grid;grid-template-columns:${COLUMNS};align-items:center;column-gap:8px;padding:0 2px}
${R} .abmd-head{position:sticky;top:0;z-index:2;height:22px;background:${T.card};border-bottom:1px solid ${T.rule};font:600 10px/1 ${FONT_UI};letter-spacing:.1em;text-transform:uppercase;color:${T.faint};user-select:none}
${R} .abmd-right{text-align:right}
${R} .abmd-row{border-bottom:1px solid ${T.rule}}
${R} .abmd-line{position:relative;height:${H + 8}px}
${R} .abmd-row[data-enabled=false] :is(.abmd-name,.abmd-status,.abmd-size){opacity:.5}
${R} .abmd-row.abmd-dragging{opacity:.4}
${R} .abmd-row[data-drop=before]{box-shadow:inset 0 2px 0 ${T.brand}}
${R} .abmd-row[data-drop=after]{box-shadow:inset 0 -2px 0 ${T.brand}}
${R} .abmd-grip{display:grid;place-items:center;height:${H}px;cursor:grab;color:${T.faint};user-select:none}
${R} .abmd-grip:hover{color:${T.ink}}
${R} .abmd-grip:active{cursor:grabbing}
${R} .abmd-name{display:flex;align-items:center;gap:5px;min-width:0;height:${H}px;padding:0;border:0;border-radius:${RADIUS_XS}px;background:none;color:${T.ink};font:600 12px/1 ${FONT_UI};text-align:left;cursor:pointer}
${R} .abmd-name span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${R} .abmd-name svg{width:10px;height:10px;flex:none;fill:none;stroke:${T.label};stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;transition:transform .12s}
${R} .abmd-name:hover{color:${T.inkHover}}
${R} .abmd-name:hover svg{stroke:${T.inkHover}}
${R} .abmd-name:focus-visible{outline:2px solid ${T.brand};outline-offset:1px}
${R} .abmd-name[data-empty=true] span{color:${T.faint};font-weight:400}
${R} .abmd-row[data-open=true] .abmd-name svg{transform:rotate(90deg)}
${R} .abmd-status{display:flex;align-items:center;gap:6px;min-width:0;font:600 11px/1 ${FONT_UI};color:${T.faint};white-space:nowrap}
${R} .abmd-status::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
${R} [data-state=installed] .abmd-status{color:${T.brandInk}}
${R} :is([data-state=missing],[data-state=queued],[data-state=auth_required]) .abmd-status{color:${T.warn}}
${R} [data-state=error] .abmd-status{color:${T.danger}}
${R} :is([data-state=downloading],[data-state=checking]) .abmd-status{color:${T.ink}}
${R} .abmd-size{text-align:right;font:500 11px/1 ${FONT_UI};font-variant-numeric:tabular-nums;color:${T.label};white-space:nowrap}
${R} .abmd-size[data-empty=true]{color:${T.faint}}
${R} .abmd-do{display:grid}
${R} .abmd-do .abmd-control{width:100%;padding:0}
${R} .abmd-bar{position:absolute;left:0;right:0;bottom:-1px;height:2px;background:${T.fill};z-index:1}
${R} .abmd-bar[hidden]{display:none}
${R} .abmd-bar i{display:block;height:100%;background:${T.brand};transition:width .3s}
${R} .abmd-bar[data-unknown=true] i{opacity:.4}
${R} .abmd-message{padding:0 2px 6px 22px;font:400 11px/1.4 ${FONT_UI};color:${T.dangerInk};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${R} .abmd-message[hidden]{display:none}
${R} [data-open=true] .abmd-message{white-space:normal;overflow-wrap:anywhere}
${R} [data-state=auth_required] .abmd-message{color:${T.warnInk}}
${R} .abmd-more{display:flex;flex-direction:column;gap:5px;padding:1px 2px 8px 22px}
${R} .abmd-more[hidden]{display:none}
${R} .abmd-more-line{display:flex;align-items:center;gap:6px;min-width:0}
${R} .abmd-more-line input{flex:1}
${R} .abmd-more-line .abmd-label:not(:first-child){margin-left:6px}
${R} .abmd-provider{flex:none;height:20px;display:inline-flex;align-items:center;padding:0 9px;border-radius:999px;background:${T.brandSoft};color:${T.brandInk};font:600 10px/1 ${FONT_UI};letter-spacing:.02em;white-space:nowrap}
${R} .abmd-pill{flex:none;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;width:84px;height:${H}px;padding:2px;border-radius:${RADIUS_CONTROL}px;background:${T.fill}}
${R} .abmd-pill button{min-width:0;border:none;border-radius:${RADIUS_XS}px;padding:0;background:transparent;color:${T.label};font:600 11px/1 ${FONT_UI};cursor:pointer}
${R} .abmd-pill button:hover{color:${T.inkHover}}
${R} .abmd-pill button.on{background:${T.brand};color:${T.onBrand}}
${R} .abmd-pill button:focus-visible{outline:2px solid ${T.brand};outline-offset:1px}
${R} details{flex:none;border-top:1px solid ${T.rule};padding-top:7px}
${R} summary{cursor:pointer;font:600 11px/1.3 ${FONT_UI};color:${T.label};user-select:none}
${R} summary:hover{color:${T.inkHover}}
${R} .abmd-fold{display:flex;flex-direction:column;gap:6px;margin-top:8px}
${R} .abmd-keyrow{display:grid;grid-template-columns:85px 1fr auto;gap:6px;align-items:center}
${R} .abmd-empty{padding:22px 12px;color:${T.faint};text-align:center;line-height:1.6}
${R} .abmd-footer [data-tone=primary]{flex:1}
`;
  document.head.append(style);
}
function build(node) {
  if (node.__ausbossDownloader) return node.__ausbossDownloader;
  css(); node.properties ||= {};
  let rows;
  try { rows = cleanList(node.properties[PROPERTY] || []); } catch { rows = []; }
  const root = el("div", "ausboss-downloader"), toolbar = el("div", "abmd-toolbar"), list = el("div", "abmd-list");
  // The list sits out of flow in its box, so a long list scrolls instead of stretching the node (Nodes 2.0 sizes a node by its content).
  const listBox = el("div", "abmd-listbox"); listBox.append(list);
  const caption = el("span", "abmd-title", "Models"), count = el("span", "abmd-hint");
  const state = {node, root, rows, list, views: [], dead: false};
  // Rows showing their link and options. A row opens by a click on its name; a new, empty row starts open.
  const open = new WeakSet();
  let dragging = null;
  node.__ausbossDownloader = state;
  function save() { node.properties[PROPERTY] = rows.map(cleanRow); notifyAusbossChange(); }
  function render() {
    const scrolled = list.scrollTop;
    list.replaceChildren(); state.views = [];
    count.textContent = `${rows.length} ${rows.length === 1 ? "model" : "models"}`;
    if (!rows.length) list.append(el("div", "abmd-empty", "Add a model link, or use From workflow to collect its links."));
    else {
      const head = el("div", "abmd-head");
      head.append(el("span"), el("span", "", "Model"), el("span", "", "Folder"), el("span", "", "Status"), el("span", "abmd-right", "Size"), el("span"), el("span"));
      list.append(head);
    }
    rows.forEach((row, index) => {
      const box = el("div", "abmd-row"); box.dataset.enabled = String(row.enabled);
      const line = el("div", "abmd-line"), more = el("div", "abmd-more");
      const name = el("button", "abmd-name"), nameText = el("span"); name.type = "button";
      name.append(actionIcon("chevron"), nameText);
      const showName = () => {
        nameText.textContent = row.filename || "New model"; name.dataset.empty = String(!row.filename);
        name.title = `${row.filename ? row.filename + "\n" : ""}Click to show or hide the link and options${row.enabled ? "" : "\nOff: Download missing skips this model"}`;
      }; showName();
      const setOpen = (value) => {
        if (value) open.add(row); else open.delete(row);
        box.dataset.open = String(value); more.hidden = !value; name.setAttribute("aria-expanded", String(value));
      };
      name.addEventListener("click", () => setOpen(more.hidden));
      const status = el("span", "abmd-status"), size = el("span", "abmd-size");
      const bar = el("div", "abmd-bar"), fill = el("i"); bar.append(fill); bar.hidden = true;
      const note = el("div", "abmd-message"); note.hidden = true;
      const provider = el("span", "abmd-provider");
      const updateProvider = () => {
        const host = row.url ? new URL(row.url).hostname : "";
        provider.textContent = host === "huggingface.co" ? "Hugging Face" : host === "civitai.com" ? "Civitai" : "Link";
      }; updateProvider();
      const dl = action("Download", "Save this model into its selected folder", () => download(row), "primary", "download");
      const cancel = action("Cancel", "Cancel this transfer and remove its partial file", async () => {
        const job = jobs.get(rowKey(row)); if (job?.id) {await request("/cancel", {id: job.id}); await poll();}
      }, "danger"); cancel.hidden = true;
      const act = el("div", "abmd-do"); act.append(dl, cancel);
      // Drag the grip to reorder; the arrows in the opened row do the same from the keyboard.
      const grip = gripIcon(); grip.title = "Drag to reorder"; grip.draggable = true;
      grip.addEventListener("dragstart", event => {
        dragging = index; box.classList.add("abmd-dragging");
        event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(ROW_DRAG, String(index));
        event.dataTransfer.setDragImage?.(box, 16, 16); event.stopPropagation();
      });
      grip.addEventListener("dragend", () => {dragging = null; box.classList.remove("abmd-dragging"); for (const v of state.views) delete v.box.dataset.drop;});
      box.addEventListener("dragover", event => {
        if (dragging === null) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
        const rect = box.getBoundingClientRect();
        box.dataset.drop = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
      });
      box.addEventListener("dragleave", event => {if (!box.contains(event.relatedTarget)) delete box.dataset.drop;});
      box.addEventListener("drop", event => {
        if (dragging === null) return;
        // Keep the drop away from ComfyUI's own file drop on the page.
        event.preventDefault(); event.stopPropagation();
        const from = dragging, after = box.dataset.drop === "after"; dragging = null;
        if (moveItem(rows, from, index, after)) save();
        render();
      });
      const folder = el("select"); folder.setAttribute("aria-label", "Model folder"); folder.title = "The models folder this file is saved in";
      folder.append(el("option", "", "Choose folder…")); folder.firstChild.value = "";
      for (const value of [...new Set([...folders, ...(row.folder ? [row.folder] : [])])]) {const o = el("option", "", value); o.value = value; folder.append(o);}
      folder.value = row.folder;
      folder.onchange = () => {row.folder = folder.value; save(); void check(row);};
      const remove = action("", "Remove this row; files on disk are kept", () => {rows.splice(index, 1); save(); render();}, "quiet", "close");
      remove.classList.add("abmd-icon-only");
      line.append(grip, name, folder, status, size, act, remove, bar);
      const source = el("div", "abmd-more-line"), url = input("Civitai or Hugging Face link", row.url);
      const fileSelect = el("select"); fileSelect.setAttribute("aria-label", "Model file"); fileSelect.hidden = true;
      let inspection = 0;
      async function inspect() {
        const generation = ++inspection;
        const checked = cleanUrl(url.value); if (!checked) return;
        // Keep the row as it was until the link resolves, so a failed lookup loses nothing.
        const info = await request("/resolve", {url: checked});
        if (generation !== inspection || state.dead) return;
        if (checked !== row.url) {row.url = checked; row.filename = "";}
        row.selected_url = checked; updateProvider(); save();
        fileSelect.replaceChildren();
        for (const file of info.files) {
          const option = el("option", "", `${file.path}${file.size ? ` · ${sizeText(file.size)}` : ""}`); option.value = file.url; fileSelect.append(option);
        }
        const choose = async () => {
          const file = info.files.find(f => f.url === fileSelect.value) || info.files[0];
          Object.assign(row, {selected_url: file.url, filename: file.filename});
          if (!row.folder && folders.includes(file.folder)) {row.folder = file.folder; folder.value = row.folder;}
          showName(); save(); await check(row);
        };
        const current = info.files.find(f => f.filename === row.filename);
        if (current) fileSelect.value = current.url;
        fileSelect.hidden = info.files.length < 2;
        fileSelect.onchange = () => choose().catch(fail);
        await choose();
      }
      url.addEventListener("change", () => inspect().catch(error => {url.value = row.url; fail(error);}));
      source.append(provider, url, action("Find files", "Read model information from this link", inspect));
      const options = el("div", "abmd-more-line"), sub = input("Subfolder (optional)", row.subfolder);
      sub.onchange = () => {row.subfolder = sub.value.trim(); save(); void check(row);};
      const pill = el("div", "abmd-pill"); pill.setAttribute("role", "group");
      pill.title = "On: Download missing includes this model. Off: it is skipped.";
      for (const value of [false, true]) {
        const side = el("button", row.enabled === value ? "on" : "", value ? "On" : "Off"); side.type = "button";
        side.setAttribute("aria-pressed", String(row.enabled === value));
        side.addEventListener("click", () => {if (row.enabled !== value) {row.enabled = value; save(); render();}});
        pill.append(side);
      }
      options.append(el("span", "abmd-label", "Subfolder"), sub, el("span", "abmd-label", "Download missing"), pill);
      for (const delta of [-1, 1]) {
        const button = action("", "Move model " + (delta < 0 ? "up" : "down"), () => {const next = index + delta; [rows[index], rows[next]] = [rows[next], rows[index]]; save(); render();}, "neutral", delta < 0 ? "up" : "down");
        button.classList.add("abmd-icon-only");
        button.disabled = index + delta < 0 || index + delta >= rows.length; options.append(button);
      }
      more.append(source, fileSelect, options);
      box.append(line, note, more); list.append(box);
      setOpen(open.has(row));
      state.views.push({row, box, status, size, bar, fill, note, dl, cancel});
    });
    list.scrollTop = scrolled;
    update();
  }
  function update() {
    for (const view of state.views) {
      const key = rowKey(view.row), job = jobs.get(key), installed = job?.state === "installed";
      view.box.dataset.state = job?.state || "";
      view.status.textContent = rowStatus(job);
      view.status.title = job?.state === "downloading" && job.total ? `${sizeText(job.downloaded) || "0 B"} of ${sizeText(job.total)}` : job?.message || statusText(job);
      const problem = ["error", "auth_required"].includes(job?.state) && job.message;
      view.note.hidden = !problem; view.note.textContent = problem || ""; view.note.title = problem || "";
      // A row keeps the size it last reported, so the column does not blank while a download waits its turn.
      if (job?.size || job?.total) sizes.set(key, job.size || job.total);
      view.size.textContent = sizeText(sizes.get(key)) || "–"; view.size.dataset.empty = String(!sizes.get(key));
      view.bar.hidden = job?.state !== "downloading"; view.bar.dataset.unknown = String(job?.progress == null);
      view.fill.style.width = job?.progress == null ? "100%" : `${job.progress}%`;
      view.cancel.hidden = !activeJob(job) || !job.id; view.dl.hidden = !view.cancel.hidden;
      view.dl.disabled = !view.row.url || !view.row.folder || activeJob(job) || installed;
      setActionLabel(view.dl, installed ? "Installed" : job?.state === "error" ? "Retry" : "Download", installed ? "check" : "download");
      view.dl.dataset.tone = installed ? "success" : "primary";
    }
  }
  toolbar.append(caption, count, el("span", "abmd-spacer"),
    action("+ Model", "Add a model link", () => {
      if (rows.length >= 100) throw new Error("The model limit is 100.");
      const row = cleanRow(); rows.push(row); open.add(row); save(); render(); list.scrollTop = list.scrollHeight;
    }),
    action("From workflow", "Collect the model links in this workflow: AusBoss notes and the links ComfyUI templates keep on loader nodes", () => {
      const known = new Set(rows.map(rowKey)), before = rows.length;
      const add = (row) => {if (row?.url && !known.has(rowKey(row)) && rows.length < 100) {rows.push(row); known.add(rowKey(row));}};
      for (const n of graphNodes()) {
        for (const entry of n.__ausbossNote?.rows || []) add(noteModel(entry.row));
        for (const row of nodeModels(n)) add(row);
      }
      if (rows.length === before) showToast({severity: "info", summary: "Model Downloader", detail: "No new Hugging Face or Civitai model links found in this workflow."});
      save(); render(); void checkAll();
    }));
  async function checkAll() { await eachAtOnce(rows.slice(), AT_ONCE, async row => {if (!state.dead) await check(row);}); }
  const footer = el("div", "abmd-toolbar abmd-footer");
  footer.append(action("Check files", "Check all registered model folders, including extra paths", checkAll, "neutral", "refresh"),
    action("Download missing", "Queue enabled models; existing files are skipped", async () => {
      const wanted = rows.filter(row => row.enabled && row.url && row.folder);
      await eachAtOnce(wanted, AT_ONCE, check);
      // Started in list order: the first three download together and the rest wait their turn.
      for (const row of wanted) if (!["installed", "auth_required"].includes(jobs.get(rowKey(row))?.state)) await download(row);
    }, "primary", "download"));
  const keys = el("details"), keyBody = el("div", "abmd-fold"); keys.append(el("summary", "", "Access keys"), keyBody);
  keyBody.append(el("div", "abmd-hint", "Saved on this machine. Never included in workflows or model lists. On a pod, set HF_TOKEN or CIVITAI_API_KEY in the template and every new pod has them."));
  const keyHint = (id) => keySources[id] === "saved" || (!keySources[id] && keyStatus[id]) ? "Saved · enter to replace"
    : keySources[id] === "environment" ? "Using the pod's environment key · enter to override" : "Access key";
  for (const [id, label] of [["civitai", "Civitai"], ["huggingface", "Hugging Face"]]) {
    const line = el("div", "abmd-keyrow"), field = input(keyHint(id), "", "password");
    field.autocomplete = "off";
    line.append(el("span", "abmd-label", label), field, action("Save", `Save the ${label} key on this machine`, async () => {
      if (!field.value) return;
      const info = await request("/keys", {[id]: field.value.trim()}); takeKeys(info); field.value = ""; field.placeholder = keyHint(id);
      showToast({detail: `${label} key saved on this machine.`});
    }));
    keyBody.append(line);
    keyBody.append(action(`Clear ${label} key`, "Remove this saved key", async () => {takeKeys(await request("/keys", {[id]: ""})); field.value = ""; field.placeholder = keyHint(id);}));
  }
  const presets = el("details"), presetBody = el("div", "abmd-fold"), presetName = input("Model list name"), presetSelect = el("select");
  presets.append(el("summary", "", "Saved model lists"), presetBody);
  async function refreshPresets() {
    const data = await request("/presets"); state.presets = data.presets; presetSelect.replaceChildren(el("option", "", "Choose a saved list…"));
    for (const name of Object.keys(data.presets)) {const option = el("option", "", name); option.value = name; presetSelect.append(option);}
  }
  presetSelect.onchange = () => { if (!state.presets[presetSelect.value]) return; rows = cleanList(state.presets[presetSelect.value]); state.rows = rows; presetName.value = presetSelect.value; save(); render(); void checkAll(); };
  const presetTools = el("div", "abmd-toolbar"), fileInput = input("Import model list", "", "file"); fileInput.accept = ".json"; fileInput.hidden = true;
  fileInput.onchange = async () => {
    try {const file = fileInput.files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new Error("Choose a model list smaller than 1 MB."); rows = cleanList(JSON.parse(await file.text())); state.rows = rows; save(); render(); void checkAll();} catch (error) {fail(error);} finally {fileInput.value = "";}
  };
  presetTools.append(action("Save list", "Save this list on this machine", async () => {await request("/presets", {name: presetName.value, models: rows.filter(r => r.url).map(cleanRow)}); await refreshPresets();}),
    action("Import JSON", "Load a saved JSON model list", () => fileInput.click()),
    action("Export JSON", "Export model links without access keys", () => {
      const blob = new Blob([JSON.stringify({version: 1, models: rows.filter(r => r.url).map(cleanRow)}, null, 2)], {type: "application/json"});
      const url = URL.createObjectURL(blob), anchor = el("a"); anchor.href = url; anchor.download = "models.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
  presetBody.append(presetSelect, presetName, presetTools, fileInput);
  root.append(toolbar, listBox, footer, keys, presets);
  root.addEventListener("pointerdown", event => event.stopPropagation());
  // Keys typed into a control stay in it. With only the panel itself focused (see below) they go on to ComfyUI.
  root.addEventListener("keydown", event => {if (event.target !== root) event.stopPropagation();});
  // Nodes 2.0 hands every wheel turn over a node to the graph, except over a box marked to keep
  // the wheel that also holds the keyboard focus. So there the panel takes the focus while the
  // pointer is over it, and gives it back when the pointer leaves. Typing elsewhere is left alone.
  root.dataset.captureWheel = "true"; root.tabIndex = -1;
  let focusBefore = null;
  root.addEventListener("pointermove", () => {
    const active = document.activeElement;
    if (root.contains(active) || !root.closest("[data-node-id]") || active?.matches?.("input,textarea,select,[contenteditable]")) return;
    focusBefore = active; root.focus({preventScroll: true});
  });
  root.addEventListener("pointerleave", () => {
    if (document.activeElement !== root) return;
    if (focusBefore?.isConnected && focusBefore !== document.body) focusBefore.focus({preventScroll: true}); else root.blur();
    focusBefore = null;
  });
  root.addEventListener("wheel", event => {
    if (event.defaultPrevented) return;
    if (wheelScrollsList(event, list)) {
      // The wheel stays with the list anywhere on this node, so it never zooms halfway down a list.
      event.stopPropagation();
      if (!list.contains(event.target)) {event.preventDefault(); list.scrollTop += wheelPixels(event, list.clientHeight);}
      return;
    }
    // Nothing to scroll: the graph zooms, as it does over the rest of a node.
    if (panelKeepsWheel(event.target, event, {root, host: root, styleOf: e => getComputedStyle(e)})) return;
    event.preventDefault(); event.stopPropagation(); app.canvas?.processMouseWheel(event);
  }, {passive: false});
  const widget = node.addDOMWidget("ausboss_model_downloader_panel", "ausboss_model_downloader", root, {serialize: false, hideOnZoom: false});
  widget.serialize = false; keepDomWidgetWidthAuto(widget);
  // What the panel needs with three rows showing, plus each opened section.
  const minHeight = () => 250 + WIDGET_FRAME + (keys.open ? 180 : 0) + (presets.open ? 150 : 0);
  fillNodeHeight(widget, {minWidth: MIN_WIDTH, minHeight, exactMinWidth: true, minNodeSize: [MIN_WIDTH, 310]});
  for (const section of [keys, presets]) section.addEventListener("toggle", () => {
    node.setSize([node.size[0], Math.max(node.size[1], minHeight() + 40)]);
  });
  applyBrandSurface(node); node.size = [660, 430];
  listeners.add(update);
  state.load = () => {try {rows = cleanList(node.properties[PROPERTY] || []);} catch {rows = [];}
    node.properties[PROPERTY] = rows.map(cleanRow); state.rows = rows; applyBrandSurface(node); render(); void checkAll();};
  state.dispose = () => {state.dead = true; listeners.delete(update);};
  render(); void refreshPresets().catch(fail);
  return state;
}

function attachNote(node) {
  const note = node.__ausbossNote;
  if (!note || node.__ausbossDownloadNote?.root === note.root) return;
  node.__ausbossDownloadNote?.dispose();
  let dead = false, scheduled = false;
  const decorate = () => {
    scheduled = false; if (dead) return;
    const lines = note.root.querySelectorAll(".ausboss-note-row");
    note.rows.forEach((entry, index) => {
      const row = noteModel(entry.row), line = lines[index];
      if (!row?.url || !folders.includes(row.folder) || !line) return;
      const actionBox = line.querySelector(".ausboss-note-action"), link = actionBox?.querySelector("a.ausboss-note-dl");
      let button = actionBox?.querySelector("button[data-ausboss-download]");
      if (link) {
        button = action("Download", `Download into ${row.folder}/${row.subfolder}`, () => download(row), "primary", "download");
        button.dataset.ausbossDownload = "true"; link.replaceWith(button);
      }
      if (!button) return;
      const job = jobs.get(rowKey(row));
      const text = activeJob(job) ? statusText(job) : job?.state === "installed" ? "Installed" : job?.state === "auth_required" ? "Access key needed" : "Download";
      setActionLabel(button, text, text === "Download" ? "download" : "");
      button.disabled = activeJob(job) || job?.state === "installed";
      button.dataset.tone = job?.state === "installed" ? "success" : job?.state === "auth_required" ? "neutral" : "primary";
      button.title = job?.state === "auth_required" ? "Add your key in Model Downloader → Access keys, then retry." : job?.message || `Download into ${row.folder}/${row.subfolder}`;
    });
  };
  const observer = new MutationObserver(() => {if (!scheduled) {scheduled = true; queueMicrotask(decorate);}});
  observer.observe(note.root, {subtree: true, childList: true}); listeners.add(decorate); decorate();
  node.__ausbossDownloadNote = {root: note.root, dispose: () => {dead = true; observer.disconnect(); listeners.delete(decorate);}};
}

app.registerExtension({
  name: "AusBoss.ModelDownloader",
  async beforeRegisterNodeDef(nodeType, data) {
    if (data.name === TYPE) {
      await infoReady;
      chainCallback(nodeType.prototype, "onNodeCreated", function () {build(this);});
      chainCallback(nodeType.prototype, "onConfigure", function () {queueMicrotask(() => build(this).load());});
      chainCallback(nodeType.prototype, "onSerialize", function (saved) {
        saved.properties ||= {};
        saved.properties[PROPERTY] = (this.__ausbossDownloader?.rows || []).map(cleanRow);
      });
      chainCallback(nodeType.prototype, "onRemoved", function () {this.__ausbossDownloader?.dispose();});
    }
    if (data.name === "AUSBOSS_NODES_WorkflowNote") {
      chainCallback(nodeType.prototype, "onNodeCreated", function () {void infoReady.then(() => attachNote(this));});
      chainCallback(nodeType.prototype, "onConfigure", function () {queueMicrotask(() => attachNote(this));});
      chainCallback(nodeType.prototype, "onRemoved", function () {this.__ausbossDownloadNote?.dispose();});
    }
  },
  async loadedGraphNode(node) {await infoReady; if (node.type === TYPE) build(node).load(); else attachNote(node);},
});
