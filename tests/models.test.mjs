import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanList, cleanRow, cleanUrl, nodeModels, noteModel, rowKey, statusText} from '../js/shared/models.mjs';
test('portable lists strip tokens, jobs, and unrelated properties', () => {
  const rows = cleanList([{url:'https://huggingface.co/a/b', hf_token:'SECRET', job:'private', enabled:false}]);
  assert.equal(rows[0].enabled, false); assert.ok(!JSON.stringify(rows).includes('SECRET')); assert.ok(!('job' in rows[0]));
  assert.deepEqual(cleanList(JSON.parse(JSON.stringify({models:rows}))), rows);
});
test('credentials in source URLs cannot enter workflows', () => {
  for (const url of ['https://civitai.com/api/download/models/1?token=SECRET', 'https://huggingface.co/a/b?access_token=SECRET','https://civitai.com.evil.test/a','http://huggingface.co/a/b']) assert.throws(() => cleanUrl(url));
});
test('notes retain destination subfolder and filename', () => {
  const row = noteModel({dir:'loras/minimax',name:'style/model.safetensors',url:'https://huggingface.co/a/b/resolve/main/model.safetensors'});
  assert.equal(row.folder,'loras'); assert.equal(row.subfolder,'minimax/style'); assert.equal(row.filename,'model.safetensors');
  assert.equal(noteModel({dir:'input',name:'image.png',url:'https://huggingface.co/a/b'}),null);
  assert.equal(noteModel({dir:'loras',name:'install.py',url:'https://huggingface.co/a/b'}),null);
});
test('job identity includes destination; presence is explicit', () => {
  const row=cleanRow({url:'https://huggingface.co/a/b',folder:'loras'});
  assert.notEqual(rowKey(row),rowKey({...row,folder:'checkpoints'}));
  assert.equal(statusText({state:'installed'}),'Installed'); assert.equal(statusText({state:'auth_required'}),'Access key needed');
});
test('old folder names map like ComfyUI does', () => {
  assert.equal(noteModel({dir:'unet',name:'m.safetensors',url:'https://huggingface.co/a/b/resolve/main/m.safetensors'}).folder,'diffusion_models');
  assert.equal(noteModel({dir:'clip',name:'t.safetensors',url:'https://huggingface.co/a/b/resolve/main/t.safetensors'}).folder,'text_encoders');
});
test('template loader nodes give their model links', () => {
  const rows = nodeModels({properties:{models:[
    {name:'qwen_image_vae.safetensors',url:'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors',directory:'vae'},
    {name:'x.safetensors',url:'https://example.com/x.safetensors',directory:'loras'}, null, {name:'readme.md',url:'https://huggingface.co/a/b',directory:'vae'}]}});
  assert.equal(rows.length,1); assert.equal(rows[0].folder,'vae'); assert.equal(rows[0].filename,'qwen_image_vae.safetensors');
  assert.deepEqual(nodeModels({properties:{}}),[]); assert.deepEqual(nodeModels(null),[]);
});
