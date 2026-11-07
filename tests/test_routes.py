import importlib
import sys
import tempfile
import types
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from downloader.policy import MODEL_EXTENSIONS


class FakeUsers:
    def get_request_user_id(self, request): return 'default'


class RouteTests(unittest.IsolatedAsyncioTestCase):
    """Routes behind a reverse proxy (RunPod, a tunnel, nginx) see a Host that is not the browser's address."""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        routes = web.RouteTableDef()
        fake_server = types.SimpleNamespace(routes=routes, user_manager=FakeUsers())
        stubs = {
            'server': types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=fake_server)),
            'folder_paths': types.SimpleNamespace(
                folder_names_and_paths={'loras': ([self.tmp.name], MODEL_EXTENSIONS)},
                get_system_user_directory=lambda name: self.tmp.name + '/' + name),
        }
        saved = {name: sys.modules.get(name) for name in stubs}
        sys.modules.update(stubs)
        sys.modules.pop('downloader.routes', None)
        try:
            importlib.import_module('downloader.routes').register()
        finally:
            for name, module in saved.items():
                if module is None: sys.modules.pop(name, None)
                else: sys.modules[name] = module
        app = web.Application(); app.add_routes(routes)
        self.client = TestClient(TestServer(app)); await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def post(self, path, headers):
        response = await self.client.post('/ausboss/model-downloader' + path, data='{}', headers=headers)
        return response.status, await response.json()

    async def test_proxied_origin_accepted(self):
        status, body = await self.post('/keys', {'Content-Type': 'application/json',
                                                 'Origin': 'https://abc123-8188.proxy.runpod.net'})
        self.assertEqual(status, 200, body)

    async def test_non_json_post_refused(self):
        status, body = await self.post('/keys', {'Content-Type': 'text/plain',
                                                 'Origin': 'https://abc123-8188.proxy.runpod.net'})
        self.assertEqual(status, 400)
        self.assertEqual(body['error'], 'Send a JSON request.')


if __name__ == '__main__':
    unittest.main()
