"""Keep the browser from running old downloader scripts after an update.

ComfyUI tells browsers never to store .js files, but sends no cache header
for .mjs, so a browser may reuse an old copy for days. After an update the
new entry script then imports functions the old copies do not have, and the
node's panel does not load. Two small pieces fix that:

- every relative .mjs import in this addon's scripts is served with a version
  tag (shared/models.mjs becomes shared/models.mjs?v=<tag>). The tag changes
  whenever any script changes, so after an update the browser asks for
  addresses it has never stored. The files on disk are not touched;
- every .mjs of this addon is served with Cache-Control: no-cache, so the
  browser asks the server before reusing it.

Same approach as the main pack. Only this addon's own script addresses are
answered; a request is looked up in a list made at startup and never opens a
path as given.
"""
import hashlib
import re
from pathlib import Path

ADDON_DIR = Path(__file__).parent.parent
# `from "./x.mjs"`, `import "./x.mjs"` and `import("./x.mjs")`: relative paths written as plain strings.
MODULE_IMPORT = re.compile(r"""(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}/[^"'?\s]+\.mjs)\2""")


def served_scripts(js_root):
    """The addon's scripts by their address below the js folder; links and outside paths left out."""
    root = Path(js_root).resolve()
    scripts = {}
    for path in sorted(root.rglob('*')):
        try:
            if path.suffix in ('.js', '.mjs') and not path.is_symlink() and path.is_file() \
                    and path.resolve().is_relative_to(root):
                scripts[path.relative_to(root).as_posix()] = path
        except OSError:
            continue
    return scripts


def module_token(scripts):
    """Short tag that changes whenever any script does."""
    digest = hashlib.sha256()
    for name, path in sorted(scripts.items()):
        digest.update(name.encode('utf-8') + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()[:10]


def add_module_version(source, token):
    """The script with ?v=<token> on every relative .mjs import in it."""
    return MODULE_IMPORT.sub(lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}?v={token}{m.group(2)}', source)


def make_middleware(addon_name, js_root):
    from aiohttp import web

    marker = f'/extensions/{addon_name}/'
    scripts = served_scripts(js_root)
    token = module_token(scripts)
    served = {}

    def tagged(path):
        """(body, etag) for a script with imports to tag, else None."""
        stat = path.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
        hit = served.get(path)
        if hit and hit[0] == stamp:
            return hit[1]
        source = path.read_text(encoding='utf-8')
        body = add_module_version(source, token).encode('utf-8')
        result = None if body == source.encode('utf-8') else (body, '"' + hashlib.sha256(body).hexdigest()[:20] + '"')
        served[path] = (stamp, result)
        return result

    @web.middleware
    async def fresh_scripts(request, handler):
        start = request.path.find(marker)
        if start < 0 or not request.path.endswith(('.js', '.mjs')):
            return await handler(request)
        target = scripts.get(request.path[start + len(marker):])
        found = None
        if target is not None and request.method in ('GET', 'HEAD'):
            try:
                found = tagged(target)
            except (OSError, ValueError):
                found = None
        if found is None:
            response = await handler(request)
            if request.path.endswith('.mjs'):
                response.headers['Cache-Control'] = 'no-cache'
            return response
        body, etag = found
        if target.suffix == '.js':
            return web.Response(body=body, content_type='text/javascript', headers={'Cache-Control': 'no-store'})
        headers = {'Cache-Control': 'no-cache', 'ETag': etag}
        if request.headers.get('If-None-Match') == etag:
            return web.Response(status=304, headers=headers)
        return web.Response(body=body, content_type='text/javascript', headers=headers)

    return fresh_scripts


def register(server):
    """Fail-soft: without it the addon still works, a browser may just need a hard refresh after an update."""
    try:
        server.app.middlewares.append(make_middleware(ADDON_DIR.name, ADDON_DIR / 'js'))
    except Exception:  # noqa: BLE001 - never stop the addon loading over a cache header
        pass
