import re
import tempfile
import unittest
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from downloader.frontend_cache import add_module_version, make_middleware, module_token, served_scripts

JS = Path(__file__).resolve().parent.parent / 'js'


class FrontendCacheTests(unittest.IsolatedAsyncioTestCase):
    """A browser never runs an old helper script beside a new entry script."""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'shared').mkdir(); (self.root / 'node').mkdir()
        (self.root / 'node/index.js').write_text('import { a } from "../shared/a.mjs";\nimport { app } from "../../../scripts/app.js";\n')
        (self.root / 'shared/a.mjs').write_text('import { b } from "./b.mjs";\nexport const a = b;\n')
        (self.root / 'shared/b.mjs').write_text('export const b = 1;\n')
        app = web.Application(middlewares=[make_middleware('addon', self.root)])
        app.router.add_static('/extensions/addon/', self.root)
        app.router.add_static('/extensions/other/', self.root)
        self.client = TestClient(TestServer(app)); await self.client.start_server(); self.addAsyncCleanup(self.client.close)

    async def test_imports_carry_a_tag_that_changes_with_any_script(self):
        token = module_token(served_scripts(self.root))
        entry = await self.client.get('/extensions/addon/node/index.js')
        self.assertEqual(entry.headers['Cache-Control'], 'no-store')
        text = await entry.text()
        self.assertIn(f'"../shared/a.mjs?v={token}"', text)
        self.assertIn('"../../../scripts/app.js"', text)
        shared = await self.client.get(f'/extensions/addon/shared/a.mjs?v={token}')
        self.assertEqual(shared.headers['Cache-Control'], 'no-cache')
        self.assertIn(f'"./b.mjs?v={token}"', await shared.text())
        again = await self.client.get('/extensions/addon/shared/a.mjs', headers={'If-None-Match': shared.headers['ETag']})
        self.assertEqual(again.status, 304)
        (self.root / 'shared/b.mjs').write_text('export const b = 2;\n')
        self.assertNotEqual(module_token(served_scripts(self.root)), token)

    async def test_plain_modules_revalidate_and_other_packs_are_left_alone(self):
        plain = await self.client.get('/extensions/addon/shared/b.mjs')
        self.assertEqual((plain.headers['Cache-Control'], await plain.text()), ('no-cache', 'export const b = 1;\n'))
        other = await self.client.get('/extensions/other/shared/a.mjs')
        self.assertNotIn('Cache-Control', other.headers)
        self.assertNotIn('?v=', await other.text())
        self.assertEqual((await self.client.get('/extensions/addon/../../etc/passwd')).status, 404)

    def test_every_module_import_in_the_addon_is_a_plain_string(self):
        # A path built in code would escape the tag and load a second, stale copy.
        for path in sorted(JS.rglob('*')):
            if path.suffix not in ('.js', '.mjs'):
                continue
            source = path.read_text(encoding='utf-8')
            tagged = add_module_version(source, 'T')
            self.assertEqual(len(re.findall(r'\.mjs\?v=T', tagged)), len(re.findall(r'\.mjs["\']', source)), path.name)


if __name__ == '__main__':
    unittest.main()
