import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from downloader.policy import (DownloadError, MODEL_EXTENSIONS, ModelFolders, auth_headers,
                               clean_rows, model_filename, source_url, suggested_folder, transfer_url)
from downloader.providers import ProviderClient
from downloader.service import DownloadService, LocalStore, install


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.models = self.root / 'models'
        self.extra = self.root / 'extra'
        self.models.mkdir(); self.extra.mkdir()
        self.folders = ModelFolders({'loras': ([str(self.models), str(self.extra)], MODEL_EXTENSIONS),
                                    'custom_nodes': ([str(self.root / 'custom_nodes')], MODEL_EXTENSIONS),
                                    'configs': ([str(self.root / 'configs')], {'.yaml'})})

    def test_only_registered_model_folders(self):
        self.assertEqual(self.folders.names(), ['loras'])
        for folder in ['custom_nodes', 'configs', 'missing', '../loras']:
            with self.subTest(folder=folder), self.assertRaises(DownloadError):
                self.folders.target(folder, '', 'model.safetensors')

    def test_traversal_and_windows_paths_refused(self):
        for part in ['../escape', '/tmp', 'C:\\Windows', 'a/../../b', 'a\\..\\b', 'custom_nodes', 'a/custom_nodes', 'a:stream', 'NUL']:
            with self.subTest(part=part), self.assertRaises(DownloadError):
                self.folders.target('loras', part, 'model.safetensors')

    def test_symlink_escape_refused(self):
        (self.models / 'escape').symlink_to(self.extra, target_is_directory=True)
        with self.assertRaises(DownloadError):
            self.folders.target('loras', 'escape', 'model.safetensors')

    def test_code_file_extensions_refused(self):
        for name in ['startup.py', 'thing.js', 'archive.zip', 'model.safetensors.py', '../model.pt', 'model.pt:code', 'CON.bin']:
            with self.subTest(name=name), self.assertRaises(DownloadError):
                model_filename(name)
        for extension in MODEL_EXTENSIONS:
            self.assertEqual(model_filename('model' + extension), 'model' + extension)

    def test_custom_nodes_registered_as_model_root_refused(self):
        self.folders.registered['loras'] = ([str(self.root / 'custom_nodes' / 'sub')], MODEL_EXTENSIONS)
        with self.assertRaises(DownloadError):
            self.folders.target('loras', '', 'model.pt')

    def test_existing_secondary_path_and_nested(self):
        (self.extra / 'style').mkdir()
        (self.extra / 'style/model.safetensors').write_bytes(b'model')
        self.assertEqual(self.folders.existing('loras', '', 'model.safetensors')[1], 'style/model.safetensors')

    def test_existing_linked_file_counts(self):
        # ComfyUI loads a linked model, so it is installed (pods link models in from a volume).
        outside = self.root / 'outside.safetensors'; outside.write_bytes(b'model')
        (self.models / 'model.safetensors').symlink_to(outside)
        self.assertEqual(self.folders.existing('loras', '', 'model.safetensors')[1], 'model.safetensors')

    def test_existing_linked_folder_and_loop(self):
        shared = self.root / 'shared'; shared.mkdir(); (shared / 'deep.safetensors').write_bytes(b'model')
        (self.models / 'shared').symlink_to(shared, target_is_directory=True)
        (shared / 'loop').symlink_to(self.models, target_is_directory=True)
        self.assertEqual(self.folders.existing('loras', '', 'deep.safetensors')[1], 'shared/deep.safetensors')
        self.assertIsNone(self.folders.existing('loras', '', 'absent.safetensors'))

    def test_dangling_link_is_not_installed(self):
        (self.models / 'gone.safetensors').symlink_to(self.root / 'missing.safetensors')
        self.assertIsNone(self.folders.existing('loras', '', 'gone.safetensors'))

    def test_tokens_only_exact_provider_host(self):
        keys = {'civitai': 'test-civ', 'huggingface': 'test-hf'}
        self.assertEqual(auth_headers('https://civitai.com/api/download/models/1', keys)['Authorization'], 'Bearer test-civ')
        self.assertEqual(auth_headers('https://huggingface.co/a/b', keys)['Authorization'], 'Bearer test-hf')
        for url in ['https://cdn.huggingface.co/a', 'https://civitai.com.evil.test/a', 'https://evil.test/?huggingface.co', 'https://cdn-lfs.hf.co/a']:
            self.assertEqual(auth_headers(url, keys), {})

    def test_url_credentials_and_untrusted_hosts_refused(self):
        for url in ['http://huggingface.co/a/b', 'https://127.0.0.1/a', 'https://civitai.com.evil.test/a',
                    'https://u:p@civitai.com/a', 'https://civitai.com/a?token=secret', 'https://huggingface.co/a/b?access_token=secret']:
            with self.subTest(url=url), self.assertRaises(DownloadError): source_url(url)
        for url in ['http://cdn-lfs.hf.co/a', 'https://127.0.0.1/a', 'https://evil.test/a', 'https://civitai.com/a']:
            with self.subTest(url=url), self.assertRaises(DownloadError): transfer_url(url, 'huggingface')

    def test_model_mapping(self):
        for kind, folder in [('LORA', 'loras'), ('Checkpoint', 'checkpoints'), ('VAE', 'vae'), ('Controlnet', 'controlnet')]:
            self.assertEqual(suggested_folder(kind), folder)
        self.assertEqual(suggested_folder(path='split_files/text_encoders/a.safetensors'), 'text_encoders')

    def test_presets_drop_tokens_and_private_state(self):
        rows = clean_rows([{'url': 'https://huggingface.co/a/b', 'civitai_token': 'secret', 'job': 'private'}])
        self.assertNotIn('secret', json.dumps(rows)); self.assertNotIn('job', rows[0])
        store = LocalStore(self.root / 'settings')
        store.save_keys({'huggingface': 'test-key'})
        self.assertEqual(store.key_status(), {'huggingface': True, 'civitai': False})
        self.assertEqual((self.root / 'settings/keys.json').stat().st_mode & 0o777, 0o600)
        store.save_preset('../../name', rows)
        self.assertTrue((self.root / 'settings/presets.json').exists())
        self.assertFalse((self.root / 'name.json').exists())


class FakeContent:
    async def iter_chunked(self, n):
        yield b'model-bytes'


class FakeResponse:
    headers = {'Content-Length': '11', 'Content-Type': 'application/octet-stream'}
    content = FakeContent()
    def close(self): pass


class FakeClient:
    def __init__(self, keys): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def resolve(self, url):
        return {'files': [{'filename': 'model.safetensors', 'url': url, 'size': 11,
                           'sha256': hashlib.sha256(b'model-bytes').hexdigest(), 'provider': 'huggingface'}]}
    async def response(self, url, provider): return FakeResponse()


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.models = self.root / 'models'; self.models.mkdir()
        self.service = DownloadService(ModelFolders({'loras': ([str(self.models)], MODEL_EXTENSIONS)}), self.root / 'settings')
        self.row = {'url': 'https://huggingface.co/a/b/resolve/main/model.safetensors', 'filename': 'model.safetensors', 'folder': 'loras', 'subfolder': 'style'}

    async def finish(self, job):
        task = self.service.tasks.get(job['id'])
        if task: await task
        return self.service.status('user', job['id'])

    async def test_transfer_atomic_and_deduplicated(self):
        with patch('downloader.service.ProviderClient', FakeClient):
            job = self.service.start('user', self.row)
            self.assertEqual(self.service.start('user', self.row)['id'], job['id'])
            result = await self.finish(job)
        self.assertEqual(result['state'], 'installed', result)
        self.assertEqual((self.models / 'style/model.safetensors').read_bytes(), b'model-bytes')
        self.assertFalse(list(self.models.rglob('*.part')))
        self.assertEqual((await self.service.check('user', self.row))['state'], 'installed')

    async def test_existing_never_overwritten(self):
        (self.models / 'model.safetensors').write_bytes(b'original')
        with patch('downloader.service.ProviderClient', FakeClient):
            result = await self.finish(self.service.start('user', self.row))
        self.assertEqual(result['state'], 'installed')
        self.assertEqual((self.models / 'model.safetensors').read_bytes(), b'original')

    async def test_hash_failure_does_not_install(self):
        class Bad(FakeClient):
            async def resolve(self, url):
                result = await super().resolve(url); result['files'][0]['sha256'] = '0' * 64; return result
        with patch('downloader.service.ProviderClient', Bad):
            result = await self.finish(self.service.start('user', self.row))
        self.assertEqual(result['state'], 'error'); self.assertIn('SHA256', result['message'])
        self.assertFalse(list(self.models.rglob('*.safetensors'))); self.assertFalse(list(self.models.rglob('*.part')))

    async def test_job_ownership_and_cancel(self):
        with patch('downloader.service.ProviderClient', FakeClient):
            await self.service.slot.acquire()
            job = self.service.start('user', self.row)
            await asyncio.sleep(0)
            with self.assertRaises(DownloadError): self.service.status('other', job['id'])
            self.service.cancel('user', job['id'])
            result = await self.finish(job)
            self.service.slot.release()
        self.assertEqual(result['state'], 'cancelled')
        self.assertFalse(list(self.models.rglob('*.part')))

    async def test_public_error_never_contains_network_secret(self):
        class Bad(FakeClient):
            async def resolve(self, url): raise RuntimeError('https://host/path?token=SECRET')
        with patch('downloader.service.ProviderClient', Bad):
            result = await self.finish(self.service.start('user', self.row))
        self.assertEqual(result['state'], 'error'); self.assertNotIn('SECRET', json.dumps(result))


    async def test_linked_model_checks_and_downloads_as_installed(self):
        outside = self.root / 'volume.safetensors'; outside.write_bytes(b'x')
        (self.models / 'model.safetensors').symlink_to(outside)
        self.assertEqual((await self.service.check('user', self.row))['state'], 'installed')
        with patch('downloader.service.ProviderClient', FakeClient):
            result = await self.finish(self.service.start('user', self.row))
        self.assertEqual(result['state'], 'installed', result)
        self.assertEqual(outside.read_bytes(), b'x')

    async def test_installs_where_hard_links_fail(self):
        # exFAT, some network volumes and FUSE mounts refuse os.link.
        with patch('downloader.service.ProviderClient', FakeClient), \
             patch('downloader.service.os.link', side_effect=PermissionError):
            result = await self.finish(self.service.start('user', self.row))
        self.assertEqual(result['state'], 'installed', result)
        target = self.models / 'style/model.safetensors'
        self.assertEqual(target.read_bytes(), b'model-bytes')
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)
        self.assertFalse(list(self.models.rglob('*.part')))

    async def test_link_fallback_never_replaces(self):
        target = self.models / 'style/model.safetensors'; target.parent.mkdir(parents=True)
        partial = target.with_name('.partial'); partial.write_bytes(b'new')
        target.write_bytes(b'old')
        with patch('downloader.service.os.link', side_effect=PermissionError), self.assertRaises(FileExistsError):
            install(partial, target)
        self.assertEqual(target.read_bytes(), b'old')

    async def test_hash_beats_rounded_size(self):
        class Rounded(FakeClient):
            async def resolve(self, url):
                data = await super().resolve(url); data['files'][0]['size'] = 12; return data
        with patch('downloader.service.ProviderClient', Rounded):
            result = await self.finish(self.service.start('user', self.row))
        self.assertEqual(result['state'], 'installed', result)

    async def test_environment_keys_used_and_saved_key_wins(self):
        store = self.service.store('user')
        with patch.dict('os.environ', {'HF_TOKEN': 'env-hf', 'CIVITAI_API_KEY': 'bad key'}, clear=False):
            self.assertEqual(store.active_keys(), {'huggingface': 'env-hf', 'civitai': ''})
            self.assertEqual(store.key_sources(), {'huggingface': 'environment', 'civitai': ''})
            self.assertEqual(store.key_status(), {'huggingface': False, 'civitai': False})
            store.save_keys({'huggingface': 'saved-hf'})
            self.assertEqual(store.active_keys()['huggingface'], 'saved-hf')
            self.assertEqual(store.key_sources()['huggingface'], 'saved')
        self.assertNotIn('env-hf', (self.root / 'settings').joinpath(store.root.name, 'keys.json').read_text())


class CivitaiTests(unittest.IsolatedAsyncioTestCase):
    async def test_pruned_model_accepted_and_full_model_first(self):
        version = {'model': {'type': 'LORA'}, 'files': [
            {'type': 'Training Data', 'name': 'data.safetensors', 'downloadUrl': 'https://civitai.com/api/download/models/1?type=Training%20Data'},
            {'type': 'Pruned Model', 'name': 'pruned.safetensors', 'downloadUrl': 'https://civitai.com/api/download/models/1?type=Pruned%20Model'},
            {'type': 'Model', 'name': 'full.safetensors', 'downloadUrl': 'https://civitai.com/api/download/models/1', 'sizeKB': 1}]}
        client = ProviderClient({})
        async def fake_json(url, provider): return version
        client.json = fake_json
        result = await client.resolve('https://civitai.com/models/5?modelVersionId=1')
        self.assertEqual([f['filename'] for f in result['files']], ['full.safetensors', 'pruned.safetensors'])
        self.assertEqual(result['files'][0]['folder'], 'loras')


class LegacyAndLoginTests(unittest.IsolatedAsyncioTestCase):
    def test_old_folder_names_map_like_comfyui(self):
        with tempfile.TemporaryDirectory() as tmp:
            unet = Path(tmp) / 'diffusion_models'; unet.mkdir()
            folders = ModelFolders({'diffusion_models': ([str(unet)], MODEL_EXTENSIONS)})
            self.assertEqual(folders.roots('unet'), [unet.resolve()])
            (unet / 'm.safetensors').write_bytes(b'x')
            self.assertIsNotNone(folders.existing('unet', '', 'm.safetensors'))
        rows = clean_rows([{'url': 'https://huggingface.co/a/b', 'folder': 'clip'}])
        self.assertEqual(rows[0]['folder'], 'text_encoders')

    async def test_civitai_login_redirect_means_key_needed(self):
        class Redirect:
            status = 307
            headers = {'Location': '/login?returnUrl=%2Fapi%2Fdownload%2Fmodels%2F1'}
            def close(self): pass
        client = ProviderClient({})
        class Session:
            async def get(self, url, **kw): return Redirect()
        client.session = Session()
        with self.assertRaises(DownloadError) as caught:
            await client.response('https://civitai.com/api/download/models/1', 'civitai')
        self.assertEqual(caught.exception.code, 'auth_required')


if __name__ == '__main__': unittest.main()
