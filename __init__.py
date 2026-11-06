"""AusBoss model downloader addon. Loading or queueing never starts a download."""
from .downloader.routes import register


class ModelDownloader:
    CATEGORY = '🆎 AusBoss/Workflow'
    DESCRIPTION = ('Keep the models a workflow needs in one list. Download missing files into '
                   'ComfyUI model folders with the Download buttons. Access keys stay on this machine.')
    SEARCH_ALIASES = ['ausboss', 'download models', 'hugging face', 'civitai', 'model manager']
    RETURN_TYPES = ()
    FUNCTION = 'noop'

    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {}}

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {'AUSBOSS_NODES_ModelDownloader': ModelDownloader}
NODE_DISPLAY_NAME_MAPPINGS = {'AUSBOSS_NODES_ModelDownloader': 'Model Downloader 🆎'}
WEB_DIRECTORY = './js'
register()
