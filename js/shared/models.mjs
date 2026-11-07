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
