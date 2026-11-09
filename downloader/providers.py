"""Provider metadata and authenticated transfers; no arbitrary URL fetch route."""
import ipaddress
import json
import re
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

import aiohttp
from aiohttp.resolver import DefaultResolver

from .policy import DownloadError, auth_headers, model_filename, source_url, suggested_folder, transfer_url


class PublicResolver(DefaultResolver):
    async def resolve(self, host, port=0, family=0):
        records = await super().resolve(host, port, family)
        if not records or any(not ipaddress.ip_address(r['host']).is_global for r in records):
            raise DownloadError('Private network download addresses are not allowed.')
        return records


class ProviderClient:
    def __init__(self, keys):
        self.keys = keys

    async def __aenter__(self):
        self.session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(resolver=PublicResolver()),
            timeout=aiohttp.ClientTimeout(total=None, connect=20, sock_read=60),
            trust_env=False, auto_decompress=False,
            headers={'User-Agent': 'AusBoss-Model-Downloader/0.2', 'Accept-Encoding': 'identity'},
        )
        return self

    async def __aexit__(self, *args):
        await self.session.close()

    async def response(self, url, provider):
        for _ in range(8):
            transfer_url(url, provider)
            response = await self.session.get(url, headers=auth_headers(url, self.keys), allow_redirects=False)
            if response.status in {301, 302, 303, 307, 308}:
                location = response.headers.get('Location', '')
                response.close()
                if not location:
                    raise DownloadError('The download redirect was empty.')
                url = urljoin(url, location)
                target = urlsplit(url)
                if target.hostname == 'civitai.com' and target.path.rstrip('/') == '/login':
                    # Civitai answers a download that needs an account with a login page, not a 401.
                    raise DownloadError('Access required. Add your Civitai key and accept any model access terms.', 'auth_required')
                continue
            if response.status in {401, 403}:
                response.close()
                raise DownloadError('Access required. Add your provider key and accept any model access terms.', 'auth_required')
            if response.status != 200:
                status = response.status
                response.close()
                raise DownloadError(f'The provider returned HTTP {status}.')
            return response
        raise DownloadError('The provider redirected too many times.')

    async def json(self, url, provider):
        response = await self.response(url, provider)
        try:
            chunks, count = [], 0
            async for chunk in response.content.iter_chunked(65536):
                count += len(chunk)
                if count > 8 * 1024 * 1024:
                    raise DownloadError('The provider returned too much metadata.')
                chunks.append(chunk)
            return json.loads(b''.join(chunks))
        finally:
            response.close()

    async def resolve(self, value):
        url = source_url(value)
        p = urlsplit(url)
        if p.hostname == 'huggingface.co':
            return await self.huggingface(p)
        return await self.civitai(p)

    async def huggingface(self, p):
        pieces = p.path.strip('/').split('/')
        if len(pieces) < 2 or any(not re.fullmatch(r'[\w.-]+', s) for s in pieces[:2]):
            raise DownloadError('Use a Hugging Face model repository or file link.')
        repo = '/'.join(pieces[:2])
        revision, wanted, prefix = 'main', '', ''
        if len(pieces) > 2:
            if len(pieces) < 4 or pieces[2] not in {'resolve', 'blob', 'tree'}:
                raise DownloadError('Use a Hugging Face repository, blob, or resolve link.')
            revision = unquote(pieces[3])
            path = unquote('/'.join(pieces[4:]))
            if pieces[2] == 'tree':
                prefix = path.rstrip('/') + '/' if path else ''
            else:
                wanted = path
                if not wanted:
                    raise DownloadError('The file link has no filename.')
        data = await self.json(f'https://huggingface.co/api/models/{repo}/revision/{quote(revision, safe="")}?blobs=true', 'huggingface')
        pinned = data.get('sha') or revision
        files = []
        for item in data.get('siblings', []):
            name = item.get('rfilename', '')
            if (wanted and name != wanted) or (prefix and not name.startswith(prefix)):
                continue
            try:
                filename = model_filename(name.split('/')[-1])
            except DownloadError:
                continue
            lfs = item.get('lfs') or {}
            files.append(dict(filename=filename, path=name,
                              url=f'https://huggingface.co/{repo}/resolve/{quote(pinned, safe="")}/{quote(name, safe="/")}',
                              size=int(lfs.get('size') or item.get('size') or 0), sha256=lfs.get('sha256', ''),
                              folder=suggested_folder(path=name), provider='huggingface'))
        if not files:
            raise DownloadError('No supported model files were found at this link.')
        return {'files': files, 'provider': 'huggingface'}

    async def civitai(self, p):
        query = parse_qs(p.query)
        match = re.fullmatch(r'/api/download/models/(\d+)/?', p.path)
        version = match.group(1) if match else (query.get('modelVersionId') or [''])[0]
        if version and version.isdigit():
            data = await self.json(f'https://civitai.com/api/v1/model-versions/{version}', 'civitai')
        else:
            match = re.match(r'^/models/(\d+)(?:/|$)', p.path)
            if not match:
                raise DownloadError('Use a Civitai model page or model download link.')
            model = await self.json(f'https://civitai.com/api/v1/models/{match.group(1)}', 'civitai')
            versions = model.get('modelVersions') or []
            if not versions:
                raise DownloadError('This model has no available versions.')
            data = versions[0]
            data['model'] = {'type': model.get('type', '')}
        files = []
        # "Pruned Model" is the only file on some versions; the extension check below keeps
        # training data, archives and configs out. Full models are listed first.
        items = sorted(data.get('files', []), key=lambda f: f.get('type') != 'Model')
        for item in items:
            if item.get('type') in {'Training Data', 'Archive', 'Config'}:
                continue
            if 'fileId' in query and str(item.get('id')) != query['fileId'][0]:
                continue
            metadata = item.get('metadata') or {}
            if any(k in query and str(metadata.get(k, '')).lower() != query[k][0].lower()
                   for k in ('format', 'size', 'fp')):
                continue
            try:
                filename = model_filename(item.get('name', ''))
                url = source_url(item.get('downloadUrl', ''))
                if urlsplit(url).hostname != 'civitai.com':
                    continue
            except DownloadError:
                continue
            files.append(dict(filename=filename, path=filename, url=url,
                              size=round(float(item.get('sizeKB') or 0) * 1024),
                              sha256=(item.get('hashes') or {}).get('SHA256', '').lower(),
                              folder=suggested_folder((data.get('model') or {}).get('type', '')),
                              provider='civitai'))
        if not files:
            raise DownloadError('No supported model files were found at this link.')
        return {'files': files, 'provider': 'civitai'}
