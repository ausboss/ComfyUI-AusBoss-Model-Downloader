"""Same-origin routes on ComfyUI's existing server."""
from functools import wraps
from urllib.parse import urlsplit
from aiohttp import web
import folder_paths
from server import PromptServer

from .policy import DownloadError, ModelFolders
from .service import DownloadService

PREFIX = '/ausboss/model-downloader'


def register():
    server = PromptServer.instance
    # System user folders cannot be read via ComfyUI's userdata HTTP routes.
    service = DownloadService(ModelFolders(folder_paths.folder_names_and_paths),
                              folder_paths.get_system_user_directory('ausboss_model_downloader'))

    def route(method, path):
        def decorate(fn):
            @wraps(fn)
            async def guarded(request):
                try:
                    origin = request.headers.get('Origin')
                    if origin and urlsplit(origin).netloc != request.host:
                        raise DownloadError('Open the downloader from this ComfyUI window.')
                    if method == 'post' and request.content_type != 'application/json':
                        raise DownloadError('Send a JSON request.')
                    user = server.user_manager.get_request_user_id(request)
                    data = await request.json() if method == 'post' else {}
                    if not isinstance(data, dict):
                        raise DownloadError('Send a JSON object.')
                    result = await fn(user, data, request)
                    return web.json_response(result, headers={'Cache-Control': 'no-store'})
                except DownloadError as exc:
                    return web.json_response({'error': str(exc), 'state': exc.code}, status=400)
                except Exception:
                    return web.json_response({'error': 'The request failed. Check the link, access key, and model folder.', 'state': 'error'}, status=400)
            getattr(server.routes, method)(PREFIX + path)(guarded)
            return guarded
        return decorate

    @route('get', '/info')
    async def info(user, data, request):
        return {'folders': service.folders.names(), 'keys': service.store(user).key_status(), 'version': 1}

    @route('post', '/keys')
    async def keys(user, data, request):
        return {'keys': service.store(user).save_keys(data)}

    @route('post', '/resolve')
    async def resolve(user, data, request):
        return await service.resolve(user, data.get('url', ''))

    @route('post', '/check')
    async def check(user, data, request):
        return await service.check(user, data)

    @route('post', '/download')
    async def download(user, data, request):
        return service.start(user, data)

    @route('get', '/jobs/{id}')
    async def status(user, data, request):
        return service.status(user, request.match_info['id'])

    @route('post', '/cancel')
    async def cancel(user, data, request):
        service.cancel(user, data.get('id'))
        return {'ok': True}

    @route('get', '/presets')
    async def presets(user, data, request):
        return {'presets': service.store(user).presets()}

    @route('post', '/presets')
    async def save_preset(user, data, request):
        service.store(user).save_preset(data.get('name'), data.get('models'))
        return {'ok': True}
