"""Validate everything supplied by a workflow, browser, or remote provider."""
from pathlib import Path, PureWindowsPath
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import re

MODEL_EXTENSIONS = frozenset({'.safetensors', '.gguf', '.ckpt', '.pt', '.bin', '.pth', '.onnx', '.sft'})
PROVIDERS = {'huggingface.co': 'huggingface', 'civitai.com': 'civitai'}
# ComfyUI still accepts the old names for these two folders (folder_paths.map_legacy),
# and older workflows and notes use them.
LEGACY_FOLDERS = {'unet': 'diffusion_models', 'clip': 'text_encoders'}
BLOCKED = {'custom_nodes', 'configs', 'datasets', 'input', 'output', 'temp', 'user'}


class DownloadError(ValueError):
    """A fixed, public message, never a URL, credential, or server path."""
    def __init__(self, message, code='error'):
        super().__init__(message)
        self.code = code


def url_parts(url):
    try:
        p = urlsplit(url)
        valid = p.scheme == 'https' and p.hostname and p.port in (None, 443)
        if not valid or p.username or p.password or '\\' in url or any(ord(c) < 32 for c in url):
            raise ValueError
        return p
    except (TypeError, ValueError):
        raise DownloadError('Use an HTTPS model link from Hugging Face or Civitai.') from None


def source_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise DownloadError('The model link is invalid.')
    p = url_parts(value.strip())
    if p.hostname not in PROVIDERS:
        raise DownloadError('Use a Hugging Face or Civitai model link.')
    allowed = {'download'} if p.hostname == 'huggingface.co' else {'modelVersionId', 'fileId', 'type', 'format', 'size', 'fp'}
    query = parse_qsl(p.query, keep_blank_values=True)
    if any(k not in allowed for k, _ in query):
        raise DownloadError('Remove credentials and extra parameters from the link. Use Access keys for tokens.')
    return urlunsplit(('https', p.hostname, p.path, urlencode(query), ''))


def transfer_url(url, provider):
    p = url_parts(url)
    host = p.hostname
    domains = ('huggingface.co', 'hf.co') if provider == 'huggingface' else ('civitai.com', 'civitai.green', 'r2.cloudflarestorage.com')
    if not any(host == d or host.endswith('.' + d) for d in domains):
        raise DownloadError('The provider redirected to an unsupported download host.')
    return url


def auth_headers(url, keys):
    host = url_parts(url).hostname
    key = keys.get(PROVIDERS.get(host, ''), '')
    return {'Authorization': 'Bearer ' + key} if key else {}


def path_parts(value, *, empty=False):
    if not isinstance(value, str) or len(value) > 512:
        raise DownloadError('Use a relative model subfolder.')
    if not value and empty:
        return ()
    if not value or PureWindowsPath(value).drive or value.startswith(('/', '\\')):
        raise DownloadError('Use a relative model subfolder.')
    parts = value.replace('\\', '/').split('/')
    if any(not p or p in {'.', '..'} or p.lower() == 'custom_nodes' or
           re.search(r'[<>:"|?*\x00-\x1f]', p) or p.endswith((' ', '.')) or
           re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', p) for p in parts):
        raise DownloadError('The model path contains an unsafe folder or filename.')
    return tuple(parts)


def model_filename(value):
    parts = path_parts(value)
    if len(parts) != 1 or Path(value).suffix.lower() not in MODEL_EXTENSIONS:
        raise DownloadError('Only model files can be downloaded.')
    return value


def contained(root, candidate):
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


class ModelFolders:
    def __init__(self, registered):
        # Only registrations that actually accept one of the allowed weight types.
        self.registered = registered

    def names(self):
        return sorted(k for k, (_, extensions) in self.registered.items()
                      if k not in BLOCKED and re.fullmatch(r'[a-zA-Z0-9_-]+', k)
                      and MODEL_EXTENSIONS.intersection(extensions))

    def roots(self, folder):
        folder = LEGACY_FOLDERS.get(folder, folder)
        if folder not in self.names():
            raise DownloadError('Choose a registered model folder. Code folders are not allowed.')
        roots = [Path(p).resolve() for p in self.registered[folder][0]]
        custom = [Path(p).resolve() for p in self.registered.get('custom_nodes', ([], []))[0]]
        roots = [p for p in roots if 'custom_nodes' not in {s.lower() for s in p.parts}
                 and not any(contained(c, p) for c in custom)]
        if not roots:
            raise DownloadError('There is no safe model folder for this type.')
        return roots

    def target(self, folder, subfolder, filename):
        root = self.roots(folder)[0]
        target = root.joinpath(*path_parts(subfolder, empty=True), model_filename(filename))
        if not contained(root, target) or target.is_symlink():
            raise DownloadError('The destination leaves the registered model folder.')
        return root, target

    def existing(self, folder, subfolder, filename):
        """Find a model the way ComfyUI's own loaders list it, symlinks included.

        Pods and shared setups often link model files or folders in from another disk.
        ComfyUI loads those, so they count as installed. This only reports that a
        name exists; nothing is read from or written to a linked location.
        """
        import os
        parts = path_parts(subfolder, empty=True)
        model_filename(filename)
        for root in self.roots(folder):
            direct = root.joinpath(*parts, filename)
            if direct.is_file():
                return direct, direct.relative_to(root).as_posix()
            seen = set()
            for parent, dirs, files in os.walk(root, followlinks=True):
                real = os.path.realpath(parent)
                if real in seen:
                    dirs[:] = []
                    continue
                seen.add(real)
                dirs[:] = [d for d in dirs if d.lower() != 'custom_nodes']
                if filename in files:
                    candidate = Path(parent) / filename
                    if candidate.is_file():
                        return candidate, candidate.relative_to(root).as_posix()
        return None


def suggested_folder(model_type='', path=''):
    kind = model_type.lower()
    mapping = {'lora': 'loras', 'locon': 'loras', 'lycoris': 'loras', 'dora': 'loras',
               'checkpoint': 'checkpoints', 'textualinversion': 'embeddings', 'vae': 'vae',
               'controlnet': 'controlnet', 'upscaler': 'upscale_models', 'hypernetwork': 'hypernetworks'}
    if kind in mapping:
        return mapping[kind]
    for part in path.lower().split('/'):
        if part in {'loras', 'vae', 'text_encoders', 'diffusion_models', 'checkpoints', 'controlnet', 'upscale_models'}:
            return part
    return ''


def clean_rows(rows):
    if not isinstance(rows, list) or len(rows) > 100:
        raise DownloadError('A model list can contain up to 100 rows.')
    clean = []
    for row in rows:
        if not isinstance(row, dict):
            raise DownloadError('The model list is invalid.')
        url = source_url(row.get('url') or row.get('selected_url') or '')
        selected = source_url(row.get('selected_url') or url)
        filename = row.get('filename') or ''
        if filename:
            model_filename(filename)
        subfolder = row.get('subfolder', '')
        path_parts(subfolder, empty=True)
        folder = row.get('folder', '')
        folder = LEGACY_FOLDERS.get(folder, folder)
        if folder and (folder in BLOCKED or not re.fullmatch(r'[a-zA-Z0-9_-]+', folder)):
            raise DownloadError('Choose a model folder.')
        clean.append(dict(url=url, selected_url=selected, filename=filename, folder=folder,
                          subfolder=subfolder, enabled=row.get('enabled', True) is not False))
    return clean
