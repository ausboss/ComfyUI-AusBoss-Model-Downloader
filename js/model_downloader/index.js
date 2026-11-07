import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { chainCallback, keepDomWidgetWidthAuto, notifyAusbossChange, showToast } from "../shared/index.mjs";
import { downloadAction, ensureDownloadControls, setActionLabel } from "../shared/download_controls.mjs";
import { fillNodeHeight } from "../shared/panel_layout.mjs";
import { panelKeepsWheel } from "../shared/canvas_passthrough.mjs";
import { activeJob, cleanList, cleanRow, cleanUrl, nodeModels, noteModel, rowKey, sizeText, statusText } from "../shared/models.mjs";

const TYPE = "AUSBOSS_NODES_ModelDownloader";
const PROPERTY = "ausboss_models";
const BASE = "/ausboss/model-downloader";
const jobs = new Map(), listeners = new Set();
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
function css() {
  ensureDownloadControls();
  if (document.getElementById("ausboss-downloader-style")) return;
  const style = el("style"); style.id = "ausboss-downloader-style";
  style.textContent = `
.ausboss-downloader{box-sizing:border-box;width:100%;height:100%;padding:10px;display:flex;flex-direction:column;gap:10px;color:#e8ebe7;background:#161f21;border-radius:7px;font:12px system-ui,sans-serif;overflow:hidden}
.ausboss-downloader *{box-sizing:border-box}
.ausboss-downloader .abmd-toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;flex:none}
.ausboss-downloader .abmd-caption{font:600 11px/1.3 system-ui,sans-serif;color:#b8c9c9}
.ausboss-downloader .abmd-hint{font:400 10px/1.3 system-ui,sans-serif;color:#91a6a9}
.ausboss-downloader .abmd-spacer{flex:1}
.ausboss-downloader .abmd-title{border-left:3px solid #00b4aa;padding-left:8px;letter-spacing:.06em;color:#e8ebe7}
.ausboss-downloader input,.ausboss-downloader select{width:100%;min-width:0;height:28px;border:1px solid #3a4b50;border-radius:4px;background:#0b1316;color:#d9e3e2;padding:4px 8px;font:11px system-ui,sans-serif;outline:none;color-scheme:dark}
.ausboss-downloader input::placeholder{color:#8b9da1}
.ausboss-downloader input:focus,.ausboss-downloader select:focus{border-color:#00b4aa;box-shadow:0 0 0 1px #00b4aa}
.ausboss-downloader .abmd-list{flex:1;min-height:105px;overflow-y:auto;display:flex;flex-direction:column;gap:9px}
.ausboss-downloader .abmd-row{flex:none;background:#202a2d;border:1px solid #3a4b50;border-radius:7px;padding:9px;display:flex;flex-direction:column;gap:8px;box-shadow:0 1px 2px #0003}
.ausboss-downloader .abmd-row[data-enabled=false]{opacity:.55}
.ausboss-downloader .abmd-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 12px system-ui,sans-serif;color:#e8ebe7}
.ausboss-downloader .abmd-provider{flex:none;padding:3px 6px;border-radius:4px;font:700 10px/1.2 system-ui,sans-serif;background:#293538;color:#b8c9c9}
.ausboss-downloader .abmd-provider[data-provider=huggingface]{background:#3f3420;color:#e8bd67}
.ausboss-downloader .abmd-provider[data-provider=civitai]{background:#213b3d;color:#a5cbc8}
.ausboss-downloader .abmd-status{display:inline-flex;align-items:center;gap:5px;font:600 10px system-ui,sans-serif;color:#b8c9c9;white-space:nowrap}
.ausboss-downloader .abmd-status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.ausboss-downloader [data-state=installed] .abmd-status{color:#6fc0aa}
.ausboss-downloader [data-state=missing] .abmd-status,.ausboss-downloader [data-state=queued] .abmd-status{color:#f5b53d}
.ausboss-downloader [data-state=error] .abmd-status{color:#ff939f}
.ausboss-downloader [data-state=auth_required] .abmd-status{color:#f5b53d}
.ausboss-downloader [data-state=downloading] .abmd-status,.ausboss-downloader [data-state=checking] .abmd-status{color:#00b4aa}
.ausboss-downloader .abmd-destination{display:grid;grid-template-columns:45px minmax(110px,1fr) minmax(100px,1fr);align-items:center;gap:7px}
.ausboss-downloader .abmd-folder-label{color:#c9b581;font-weight:600}
.ausboss-downloader .abmd-row-tools{gap:4px}
.ausboss-downloader .abmd-message{font:400 11px/1.4 system-ui,sans-serif;color:#ffb4bd;overflow-wrap:anywhere}
.ausboss-downloader [data-state=auth_required] .abmd-message{color:#f5c56b}
.ausboss-downloader .abmd-size{color:#a3b6b5;font:10px ui-monospace,monospace;margin-left:4px}
.ausboss-downloader progress{width:100%;height:4px;accent-color:#00b4aa}
.ausboss-downloader details{flex:none;border:1px solid #34464b;border-radius:5px;background:#1c282c;padding:7px 9px}
.ausboss-downloader summary{cursor:pointer;font:600 11px/1.3 system-ui,sans-serif;color:#b2c6c3}
.ausboss-downloader .abmd-fold{display:flex;flex-direction:column;gap:7px;margin-top:9px}
.ausboss-downloader .abmd-keyrow{display:grid;grid-template-columns:85px 1fr auto;gap:6px;align-items:center}
.ausboss-downloader .abmd-empty{padding:24px 12px;border:1px dashed #47585b;border-radius:6px;background:#202a2d;color:#a3b6b5;text-align:center;line-height:1.6}
.ausboss-downloader .abmd-footer{padding-top:2px}
.ausboss-downloader .abmd-footer [data-tone=primary]{flex:1;min-height:32px;font-size:12px}
`;
  document.head.append(style);
}
function build(node) {
  if (node.__ausbossDownloader) return node.__ausbossDownloader;
  css(); node.properties ||= {};
  let rows;
  try { rows = cleanList(node.properties[PROPERTY] || []); } catch { rows = []; }
  const root = el("div", "ausboss-downloader"), toolbar = el("div", "abmd-toolbar"), list = el("div", "abmd-list");
  const caption = el("span", "abmd-caption abmd-title", "MODELS"), count = el("span", "abmd-hint");
  const state = {node, root, rows, list, views: [], dead: false};
  node.__ausbossDownloader = state;
  function save() { node.properties[PROPERTY] = rows.map(cleanRow); notifyAusbossChange(); }
  function render() {
    list.replaceChildren(); state.views = [];
    count.textContent = `${rows.length} ${rows.length === 1 ? "model" : "models"}`;
    if (!rows.length) list.append(el("div", "abmd-empty", "Add a model link, or use From workflow to collect its links."));
    rows.forEach((row, index) => {
      const box = el("div", "abmd-row"); box.dataset.enabled = String(row.enabled);
      const head = el("div", "abmd-toolbar"), name = el("span", "abmd-name", row.filename || `Model ${index + 1}`);
      const status = el("span", "abmd-status"), size = el("span", "abmd-size"), progress = el("progress"); progress.max = 100; progress.hidden = true;
      const note = el("div", "abmd-message"); note.hidden = true;
      const provider = el("span", "abmd-provider");
      const updateProvider = () => {
        const host = row.url ? new URL(row.url).hostname : "";
        provider.dataset.provider = host === "huggingface.co" ? "huggingface" : host === "civitai.com" ? "civitai" : "";
        provider.textContent = host === "huggingface.co" ? "HF" : host === "civitai.com" ? "Civitai" : "URL";
        provider.title = host === "huggingface.co" ? "Hugging Face" : host || "Paste a model URL";
      }; updateProvider();
      const on = action(row.enabled ? "On" : "Off", "Include this model in Download missing", () => {row.enabled = !row.enabled; save(); render();});
      on.setAttribute("aria-pressed", String(row.enabled));
      on.classList.add("abmd-enabled");
      const dl = action("Download", "Save this model into its selected folder", () => download(row), "primary", "download");
      const cancel = action("Cancel", "Cancel this transfer and remove its partial file", async () => {
        const job = jobs.get(rowKey(row)); if (job?.id) {await request("/cancel", {id: job.id}); await poll();}
      }, "danger"); cancel.hidden = true;
      head.append(provider, name, on, dl, cancel);
      const source = el("div", "abmd-toolbar"), url = input("Civitai or Hugging Face link", row.url);
      url.style.flex = "1";
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
          name.textContent = row.filename; save(); await check(row);
        };
        const current = info.files.find(f => f.filename === row.filename);
        if (current) fileSelect.value = current.url;
        fileSelect.hidden = info.files.length < 2;
        fileSelect.onchange = () => choose().catch(fail);
        await choose();
      }
      url.addEventListener("change", () => inspect().catch(error => {url.value = row.url; fail(error);}));
      source.append(url, action("Find files", "Read model information from this link", inspect));
      const destination = el("div", "abmd-destination"), folder = el("select"), sub = input("Subfolder (optional)", row.subfolder);
      folder.setAttribute("aria-label", "Model folder");
      folder.append(el("option", "", "Choose folder…")); folder.firstChild.value = "";
      for (const value of [...new Set([...folders, ...(row.folder ? [row.folder] : [])])]) {const o = el("option", "", value); o.value = value; folder.append(o);}
      folder.value = row.folder;
      folder.onchange = () => {row.folder = folder.value; save(); void check(row);};
      sub.onchange = () => {row.subfolder = sub.value.trim(); save(); void check(row);};
      destination.append(el("span", "abmd-hint abmd-folder-label", "Folder"), folder, sub);
      const tools = el("div", "abmd-toolbar abmd-row-tools");
      tools.append(status, size, el("span", "abmd-spacer"));
      for (const delta of [-1, 1]) {
        const button = action("", "Move model " + (delta < 0 ? "up" : "down"), () => {const next = index + delta; [rows[index], rows[next]] = [rows[next], rows[index]]; save(); render();}, "neutral", delta < 0 ? "up" : "down");
        button.classList.add("abmd-icon-only");
        button.disabled = index + delta < 0 || index + delta >= rows.length; tools.append(button);
      }
      tools.append(action("×", "Remove this row; files on disk are kept", () => {rows.splice(index, 1); save(); render();}, "danger"));
      box.append(head, source, fileSelect, destination, progress, note, tools); list.append(box);
      state.views.push({row, box, status, size, progress, note, dl, cancel});
    });
    update();
  }
  function update() {
    for (const view of state.views) {
      const job = jobs.get(rowKey(view.row)); view.box.dataset.state = job?.state || "";
      view.status.textContent = statusText(job); view.status.title = job?.message || "";
      const problem = ["error", "auth_required"].includes(job?.state) && job.message;
      view.note.hidden = !problem; view.note.textContent = problem || "";
      view.size.textContent = sizeText(job?.size || job?.total);
      view.progress.hidden = !activeJob(job);
      if (job?.progress != null) view.progress.value = job.progress; else view.progress.removeAttribute("value");
      view.dl.disabled = !view.row.url || !view.row.folder || activeJob(job) || job?.state === "installed";
      setActionLabel(view.dl, job?.state === "installed" ? "✓ Installed" : "Download", job?.state === "installed" ? "" : "download");
      view.dl.dataset.tone = job?.state === "installed" ? "success" : "primary";
      view.cancel.hidden = !activeJob(job) || !job.id;
    }
  }
  toolbar.append(caption, count, el("span", "abmd-spacer"),
    action("+ Model", "Add a model link", () => {if (rows.length >= 100) throw new Error("The model limit is 100."); rows.push(cleanRow()); save(); render();}),
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
  async function checkAll() { for (const row of rows) if (!state.dead) await check(row); }
  const footer = el("div", "abmd-toolbar abmd-footer");
  footer.append(action("↻ Check files", "Check all registered model folders, including extra paths", checkAll),
    action("Download missing", "Queue enabled models; existing files are skipped", async () => {
      for (const row of rows) if (row.enabled && row.url) {await check(row); if (jobs.get(rowKey(row))?.state !== "installed") await download(row);}
    }, "primary", "download"));
  const keys = el("details"), keyBody = el("div", "abmd-fold"); keys.append(el("summary", "", "Access keys"), keyBody);
  keyBody.append(el("div", "abmd-hint", "Saved on this machine. Never included in workflows or model lists. On a pod, set HF_TOKEN or CIVITAI_API_KEY in the template and every new pod has them."));
  const keyHint = (id) => keySources[id] === "saved" || (!keySources[id] && keyStatus[id]) ? "Saved · enter to replace"
    : keySources[id] === "environment" ? "Using the pod's environment key · enter to override" : "Access key";
  for (const [id, label] of [["civitai", "Civitai"], ["huggingface", "Hugging Face"]]) {
    const line = el("div", "abmd-keyrow"), field = input(keyHint(id), "", "password");
    field.autocomplete = "off";
    line.append(el("span", "abmd-caption", label), field, action("Save", `Save the ${label} key on this machine`, async () => {
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
  root.append(toolbar, list, footer, keys, presets);
  root.addEventListener("pointerdown", event => event.stopPropagation());
  root.addEventListener("keydown", event => event.stopPropagation());
  // The base pack handles these panels when installed. Standalone preview fallback.
  root.addEventListener("wheel", event => {
    if (app.extensions?.some(e => e.name === "AusBoss.CanvasPassthrough")) return;
    if (panelKeepsWheel(event.target, event, {root, host: root, styleOf: e => getComputedStyle(e), activeElement: document.activeElement})) return;
    event.preventDefault(); event.stopPropagation(); app.canvas?.processMouseWheel(event);
  }, {passive: false});
  const widget = node.addDOMWidget("ausboss_model_downloader_panel", "ausboss_model_downloader", root, {serialize: false, hideOnZoom: false});
  widget.serialize = false; keepDomWidgetWidthAuto(widget);
  const minHeight = () => 400 + (keys.open ? 180 : 0) + (presets.open ? 150 : 0);
  fillNodeHeight(widget, {minWidth: 530, minHeight, exactMinWidth: true, minNodeSize: [530, 440]});
  for (const section of [keys, presets]) section.addEventListener("toggle", () => {
    node.setSize([node.size[0], Math.max(node.size[1], minHeight() + 40)]);
  });
  applyBrandSurface(node); node.size = [600, 540];
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
