"""A few background transfers at a time, with local credentials and atomic files."""
import asyncio
import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import uuid

from .policy import DownloadError, clean_rows, contained, model_filename, source_url
from .providers import Connections, ProviderClient


PROVIDERS = ('civitai', 'huggingface')
WRITE_BLOCK = 8 * 1024 * 1024
AT_ONCE = 3  # Transfers that run together; the rest wait their turn in the order they were started.
LOOKUP_SECONDS = 600  # How long a link's file list is reused, so a check and its download ask once.


def valid_key(value):
    return isinstance(value, str) and len(value) <= 1024 and not any(ord(c) < 33 or ord(c) > 126 for c in value)


class LocalStore:
    def __init__(self, root):
        self.root = Path(root)

    def read(self, name):
        path = self.root / name
        if path.is_symlink():
            raise DownloadError('The settings file is not safe to read.')
        try:
            return json.loads(path.read_text())
        except FileNotFoundError:
            return {}
        except (ValueError, OSError):
            raise DownloadError('Could not read the saved settings.') from None

    def write(self, name, data):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temp = tempfile.mkstemp(prefix='.save-', dir=self.root)
        try:
            with os.fdopen(fd, 'w') as handle:
                json.dump(data, handle, indent=2)
            os.replace(temp, self.root / name)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def keys(self):
        return self.read('keys.json')

    def active_keys(self):
        saved = self.keys()
        return {k: saved.get(k) or '' for k in PROVIDERS}

    def key_status(self):
        keys = self.keys()
        return {k: bool(keys.get(k)) for k in PROVIDERS}

    def save_keys(self, data):
        keys = self.keys()
        for k in PROVIDERS:
            if k in data:
                value = data[k]
                if not valid_key(value):
                    raise DownloadError('The access key has invalid characters.')
                keys[k] = value
        self.write('keys.json', keys)
        return self.key_status()

    def presets(self):
        return self.read('presets.json')

    def save_preset(self, name, rows):
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise DownloadError('Name this model list using 1 to 80 characters.')
        presets = self.presets()
        if name not in presets and len(presets) >= 100:
            raise DownloadError('The saved model list limit is 100.')
        presets[name.strip()] = clean_rows(rows)
        self.write('presets.json', presets)


def install(partial, target):
    """Move a finished download into place without ever replacing an existing file."""
    try:
        # Same-directory hard link is exclusive and atomic.
        os.link(partial, target)
        return
    except FileExistsError:
        raise
    except OSError:
        pass  # exFAT, some network volumes and FUSE mounts have no hard links.
    # Claim the name exclusively first, then move the finished file over our own claim.
    os.close(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o644))
    try:
        os.replace(partial, target)
    except BaseException:
        target.unlink(missing_ok=True)
        raise


class DownloadService:
    def __init__(self, folders, storage):
        self.folders, self.storage = folders, Path(storage)
        self.jobs, self.tasks, self.claims, self.lookups = {}, {}, {}, {}
        self.slot = asyncio.Semaphore(AT_ONCE)
        self.connections = Connections()

    def store(self, user):
        # A user id never becomes a filesystem path.
        return LocalStore(self.storage / hashlib.sha256(user.encode()).hexdigest())

    def client(self, user):
        return ProviderClient(self.store(user).active_keys(), self.connections)

    async def resolve(self, user, url):
        key, now = (user, url), time.monotonic()
        cached = self.lookups.get(key)
        if cached and now - cached[0] < LOOKUP_SECONDS:
            return copy.deepcopy(cached[1])
        async with self.client(user) as client:
            data = await client.resolve(url)
        # Only answers are kept, never failures: a key added a moment later must be tried.
        for old in [k for k, (at, _) in self.lookups.items() if now - at >= LOOKUP_SECONDS][:64]:
            del self.lookups[old]
        if len(self.lookups) >= 256:
            del self.lookups[next(iter(self.lookups))]
        self.lookups[key] = (now, copy.deepcopy(data))
        return data

    def forget(self, user):
        """A changed access key can open files the last lookup could not see."""
        for key in [k for k in self.lookups if k[0] == user]:
            del self.lookups[key]

    async def select(self, user, row):
        data = await self.resolve(user, row.get('selected_url') or row.get('url', ''))
        files = data['files']
        requested = row.get('filename', '')
        if requested:
            model_filename(requested)
            matches = [item for item in files if item['filename'] == requested]
            if not matches:
                raise DownloadError('The link does not contain the named model. Choose a file from the list.')
            files = matches
        if len(files) != 1:
            raise DownloadError('Choose one model file from this repository first.')
        return files[0]

    async def check(self, user, row):
        signature = (user, json.dumps(clean_rows([row])[0], sort_keys=True))
        for job in self.jobs.values():
            if job['_signature'] == signature and job['state'] in {'queued', 'downloading'}:
                return self.public(job)
        source_url(row.get('selected_url') or row.get('url', ''))
        folder, subfolder = row.get('folder', ''), row.get('subfolder', '')
        self.folders.roots(folder)
        filename, info = row.get('filename', ''), None
        if not filename:
            info = await self.select(user, row)
            filename = info['filename']
        # Look before validating the write path: a linked model is installed, not an error.
        existing = await asyncio.to_thread(self.folders.existing, folder, subfolder, filename)
        if existing:
            return {'state': 'installed', 'filename': filename, 'path': existing[1], 'size': existing[0].stat().st_size}
        self.folders.target(folder, subfolder, filename)
        if info is None:
            info = await self.size_of(user, row)
        return {'state': 'missing', 'filename': filename, 'path': '', 'size': (info or {}).get('size', 0)}

    async def size_of(self, user, row):
        """How big a missing model is, so the list shows what a download will take.

        Only a needed access key is worth reporting before Download is clicked; any other
        problem (offline, a renamed file) shows up when the download starts.
        """
        try:
            return await self.select(user, row)
        except DownloadError as exc:
            if exc.code == 'auth_required':
                raise
            return None
        except Exception:
            return None

    def start(self, user, row):
        row = clean_rows([row])[0]
        self.folders.roots(row['folder'])
        if row['filename']:
            self.folders.target(row['folder'], row['subfolder'], row['filename'])
        signature = (user, json.dumps(row, sort_keys=True))
        for job in self.jobs.values():
            if job['_signature'] == signature and job['state'] in {'queued', 'downloading'}:
                return self.public(job)
        if sum(j['state'] in {'queued', 'downloading'} for j in self.jobs.values()) >= 64:
            raise DownloadError('The download queue is full. Wait for a transfer to finish.')
        for old in list(self.jobs):
            if len(self.jobs) < 256:
                break
            if self.jobs[old]['state'] not in {'queued', 'downloading'}:
                del self.jobs[old]
        job = dict(id=uuid.uuid4().hex, state='queued', downloaded=0, total=0, progress=None,
                   filename=row['filename'], folder=row['folder'], message='Waiting to download',
                   _user=user, _signature=signature)
        self.jobs[job['id']] = job
        task = asyncio.create_task(self.run(user, row, job))
        self.tasks[job['id']] = task
        task.add_done_callback(lambda _: self.tasks.pop(job['id'], None))
        return self.public(job)

    @staticmethod
    def public(job):
        return {k: v for k, v in job.items() if not k.startswith('_')}

    def status(self, user, identifier):
        job = self.jobs.get(identifier)
        if not job or job['_user'] != user:
            raise DownloadError('This download is no longer in the queue.')
        return self.public(job)

    def cancel(self, user, identifier):
        self.status(user, identifier)
        if identifier in self.tasks:
            self.jobs[identifier].update(state='cancelled', message='Cancelled')
            self.tasks[identifier].cancel()

    @contextlib.asynccontextmanager
    async def claimed(self, key):
        """One transfer per model name in a folder type, which is how a model counts as installed.

        A second transfer of the same name waits, then finds the model installed.
        """
        entry = self.claims.setdefault(key, [asyncio.Lock(), 0])
        entry[1] += 1
        try:
            async with entry[0]:
                yield
        finally:
            entry[1] -= 1
            if not entry[1]:
                self.claims.pop(key, None)

    def owed(self, job):
        """Bytes the other running transfers still have to write to the same disk."""
        return sum(max(0, other['_need'] - other['downloaded']) for other in self.jobs.values()
                   if other is not job and other['state'] == 'downloading' and other.get('_disk') == job['_disk'])

    async def run(self, user, row, job):
        partial = None
        try:
            async with self.slot, contextlib.AsyncExitStack() as held:
                job.update(state='downloading', message='Checking model')
                info = await self.select(user, row)
                filename = info['filename']
                await held.enter_async_context(self.claimed((row['folder'], filename)))
                found = await asyncio.to_thread(self.folders.existing, row['folder'], row['subfolder'], filename)
                if found:
                    # Presence is filename-based; never overwrite an existing model.
                    job.update(state='installed', filename=filename, path=found[1], message='Already installed', progress=100)
                    return
                root, target = self.folders.target(row['folder'], row['subfolder'], filename)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not contained(root, target):
                    raise DownloadError('The destination leaves the registered model folder.')
                # Transfers that run together share the disk: count what the others still need.
                job.update(_disk=os.stat(target.parent).st_dev, _need=info['size'])
                free = shutil.disk_usage(target.parent).free - self.owed(job)
                if info['size'] + 32 * 1024 * 1024 > free:
                    raise DownloadError('There is not enough free disk space for this model.')
                partial = target.with_name('.' + filename + '.' + job['id'] + '.part')
                digest = hashlib.sha256()
                async with self.client(user) as client:
                    response = await client.response(info['url'], info['provider'])
                    try:
                        if any(t in response.headers.get('Content-Type', '').lower() for t in ('text/html', 'application/json')):
                            raise DownloadError('The provider returned a web page instead of a model.')
                        content_length = int(response.headers.get('Content-Length') or 0)
                        total = content_length or info['size']
                        if total + 32 * 1024 * 1024 > free:
                            raise DownloadError('There is not enough free disk space for this model.')
                        job.update(filename=filename, total=total, _need=total, message='Downloading')
                        fd = os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o644)
                        with os.fdopen(fd, 'wb') as handle:
                            def flush(block):
                                handle.write(block); digest.update(block)
                            buffer = bytearray()
                            # Disk writes and hashing run off the event loop: a slow network
                            # volume must not freeze ComfyUI's page while a model streams in.
                            async for chunk in response.content.iter_chunked(1024 * 1024):
                                if job['downloaded'] + len(chunk) + 32 * 1024 * 1024 > free:
                                    raise DownloadError('The download exceeded the available disk space.')
                                buffer += chunk
                                job['downloaded'] += len(chunk)
                                job['progress'] = min(99, round(job['downloaded'] / total * 100)) if total else None
                                if len(buffer) >= WRITE_BLOCK:
                                    await asyncio.to_thread(flush, bytes(buffer)); buffer.clear()
                            if buffer:
                                await asyncio.to_thread(flush, bytes(buffer))
                        if not job['downloaded'] or (content_length and job['downloaded'] != content_length):
                            raise DownloadError('The transfer was incomplete. Try again.')
                        expected = info.get('sha256', '')
                        if expected and digest.hexdigest().lower() != expected.lower():
                            raise DownloadError('The downloaded file failed its SHA256 check.')
                        # Civitai sizes are rounded kilobytes; the SHA256 is the real check when present.
                        if not expected and info['size'] and job['downloaded'] != info['size']:
                            raise DownloadError('The file size does not match the provider metadata. Try again.')
                        if not contained(root, target):
                            raise DownloadError('The destination leaves the registered model folder.')
                        await asyncio.to_thread(install, partial, target)
                        job.update(state='installed', progress=100, path=target.relative_to(root).as_posix(), message='Installed')
                    finally:
                        response.close()
        except asyncio.CancelledError:
            job.update(state='cancelled', message='Cancelled')
        except DownloadError as exc:
            job.update(state=exc.code, message=str(exc))
        except FileExistsError:
            job.update(state='error', message='A file appeared at the destination. Check files before trying again.')
        except Exception:
            # Network errors include signed URLs; keep raw exceptions off the UI and logs.
            job.update(state='error', message='The download failed. Check the link, connection, access key, and free disk space.')
        finally:
            if partial is not None:
                try:
                    partial.unlink(missing_ok=True)
                except OSError:
                    job.update(state='error', message='Could not remove the partial download. Check folder permissions.')
