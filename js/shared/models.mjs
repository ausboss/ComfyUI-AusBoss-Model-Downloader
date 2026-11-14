// Portable model lists contain no access keys, job ids, or machine paths.
export const MODEL_EXTENSIONS = /\.(safetensors|gguf|ckpt|pt|bin|pth|onnx|sft)$/i;
export function cleanUrl(value) {
  if (!value) return "";
  const url = new URL(String(value).trim());
  if (url.protocol !== "https:" || !["huggingface.co", "civitai.com"].includes(url.hostname) || url.port || url.username || url.password)
    throw new Error("Use an HTTPS model link from Hugging Face or Civitai.");
  const allowed = url.hostname === "huggingface.co" ? ["download"] : ["modelVersionId", "fileId", "type", "format", "size", "fp"];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key))
    throw new Error("Remove credentials from the link. Enter tokens in Access keys.");
  url.hash = "";
  return url.href;
}
export function cleanRow(row = {}) {
  const url = cleanUrl(row.url || row.selected_url || "");
  const filename = String(row.filename || "");
  return { url, selected_url: cleanUrl(row.selected_url || url), filename,
    folder: String(row.folder || ""), subfolder: String(row.subfolder || ""), enabled: row.enabled !== false };
}
export function cleanList(value) {
  const rows = Array.isArray(value) ? value : value?.models;
  if (!Array.isArray(rows) || rows.length > 100) throw new Error("Choose a model list with up to 100 rows.");
  return rows.map(cleanRow);
}
// ComfyUI still accepts these old folder names (folder_paths.map_legacy); older notes use them.
const LEGACY_FOLDERS = {unet: "diffusion_models", clip: "text_encoders"};
export function noteModel(row) {
  const dirs = String(row.dir || "").replaceAll("\\", "/").split("/").filter(Boolean);
  const names = String(row.name || "").replaceAll("\\", "/").split("/");
  const filename = names.pop();
  if (!MODEL_EXTENSIONS.test(filename) || !dirs[0] || dirs[0] === "input") return null;
  const folder = dirs.shift();
  try { return cleanRow({url: row.url, filename, folder: LEGACY_FOLDERS[folder] || folder, subfolder: [...dirs, ...names].join("/")}); }
  catch { return null; }
}
// ComfyUI's own templates list each loader's model on the node: properties.models = [{name, url, directory}].
export function nodeModels(node) {
  const list = node?.properties?.models;
  return Array.isArray(list) ? list.map(m => m && noteModel({dir: m.directory, name: m.name, url: m.url})).filter(Boolean) : [];
}
export function rowKey(row) {
  return JSON.stringify([row.selected_url || row.url, row.folder, row.subfolder, row.filename]);
}
export function sizeText(n) {
  if (!(n > 0)) return "";
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB"][i]}`;
}
export const activeJob = (job) => ["queued", "downloading"].includes(job?.state);
export function statusText(job) {
  if (!job) return "Not checked";
  if (job.state === "downloading") return job.progress == null ? "Downloading…" : `${job.progress}% · ${sizeText(job.downloaded)}`;
  return {installed: "Installed", missing: "Missing", checking: "Checking…", queued: "Queued", auth_required: "Access key needed", cancelled: "Cancelled", error: "Retry"}[job.state] || "Not checked";
}
// The few words that fit the list's Status column; the size has a column of its own.
export function rowStatus(job) {
  if (job?.state === "downloading") return job.progress == null ? "Starting…" : `${job.progress}%`;
  return {installed: "Installed", missing: "Missing", checking: "Checking…", queued: "Queued", auth_required: "Needs key", cancelled: "Cancelled", error: "Failed"}[job?.state] || "Not checked";
}
// Run fn on every item, at most `limit` at once, in list order.
export async function eachAtOnce(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
}
// Move one row to where it was dropped: before `to`, or after it when `after` is set.
export function moveItem(list, from, to, after = false) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return false;
  const [item] = list.splice(from, 1);
  let at = to > from ? to - 1 : to;
  if (after) at += 1;
  list.splice(at, 0, item);
  return true;
}
// Over the downloader the wheel scrolls the model list, at the list's top and bottom too.
// The graph zooms only on a pinch (Ctrl + wheel) or when the list has nothing to scroll.
export function wheelScrollsList(event, list) {
  if (!list || event.ctrlKey || event.metaKey) return false;
  return list.scrollHeight - list.clientHeight > 1;
}
// How far one wheel step moves the list: mice report pixels, lines or pages.
export function wheelPixels(event, page) {
  return event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? page : 1);
}
