import unittest
from downloader.policy import DownloadError
from downloader.providers import ProviderClient


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_civitai_file_id_and_type_mapping(self):
        class Client(ProviderClient):
            async def json(self, url, provider):
                return {'model': {'type': 'LORA'}, 'files': [
                    {'id': 2, 'name': 'first.safetensors', 'type': 'Model', 'downloadUrl': 'https://civitai.com/api/download/models/1?fileId=2'},
                    {'id': 3, 'name': 'second.safetensors', 'type': 'Model', 'downloadUrl': 'https://civitai.com/api/download/models/1?fileId=3'},
                    {'id': 4, 'name': 'install.py', 'type': 'Model', 'downloadUrl': 'https://civitai.com/api/download/models/1?fileId=4'}]}
        result = await Client({}).resolve('https://civitai.com/api/download/models/1?fileId=3')
        self.assertEqual(len(result['files']), 1)
        self.assertEqual(result['files'][0]['filename'], 'second.safetensors')
        self.assertEqual(result['files'][0]['folder'], 'loras')

    async def test_hf_revision_file_picker_and_filter(self):
        class Client(ProviderClient):
            async def json(self, url, provider):
                self.requested = url
                return {'sha': 'a' * 40, 'siblings': [
                    {'rfilename': 'loras/one.safetensors', 'size': 10},
                    {'rfilename': 'two.gguf', 'size': 20}, {'rfilename': 'install.py', 'size': 30}]}
        c = Client({})
        result = await c.resolve('https://huggingface.co/owner/repo/tree/dev')
        self.assertIn('/revision/dev?blobs=true', c.requested)
        self.assertEqual(len(result['files']), 2)
        self.assertIn('/resolve/' + 'a' * 40, result['files'][0]['url'])
        self.assertEqual(result['files'][0]['folder'], 'loras')
        result = await c.resolve('https://huggingface.co/owner/repo/blob/dev/loras/one.safetensors')
        self.assertEqual(len(result['files']), 1)

    async def test_redirect_drops_authorization_and_blocks_other_hosts(self):
        class Response:
            def __init__(self, status, location=''):
                self.status=status; self.headers={'Location':location}; self.closed=False
            def close(self): self.closed=True
        class Session:
            def __init__(self, location): self.calls=[]; self.location=location
            async def get(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return Response(302, self.location) if len(self.calls)==1 else Response(200)
        c=ProviderClient({'huggingface':'test-secret'})
        c.session=Session('https://cdn-lfs.hf.co/file?signature=opaque')
        await c.response('https://huggingface.co/a/b/resolve/main/model.pt','huggingface')
        self.assertIn('Authorization',c.session.calls[0][1]['headers'])
        self.assertEqual(c.session.calls[1][1]['headers'],{})
        c.session=Session('https://127.0.0.1/private')
        with self.assertRaises(DownloadError): await c.response('https://huggingface.co/a/b','huggingface')
        self.assertEqual(len(c.session.calls),1)

    async def test_missing_key_reported_without_url_or_token(self):
        class Response:
            status=401
            headers={}
            def close(self): pass
        class Session:
            async def get(self,*args,**kwargs): return Response()
        c=ProviderClient({'civitai':'test-secret'}); c.session=Session()
        with self.assertRaises(DownloadError) as err: await c.response('https://civitai.com/api/download/models/1','civitai')
        self.assertEqual(err.exception.code,'auth_required')
        self.assertNotIn('test-secret',str(err.exception))
