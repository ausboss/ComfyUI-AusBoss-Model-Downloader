import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanList, cleanRow, cleanUrl, eachAtOnce, moveItem, nodeModels, noteModel, rowKey, rowStatus, statusText, wheelPixels, wheelScrollsList} from '../js/shared/models.mjs';
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
test('rows move to where they are dropped', () => {
  const rows = ['a', 'b', 'c', 'd'];
  assert.ok(moveItem(rows, 0, 2)); assert.deepEqual(rows, ['b', 'a', 'c', 'd']);
  assert.ok(moveItem(rows, 0, 3, true)); assert.deepEqual(rows, ['a', 'c', 'd', 'b']);
  assert.ok(moveItem(rows, 3, 0)); assert.deepEqual(rows, ['b', 'a', 'c', 'd']);
  assert.equal(moveItem(rows, 1, 1), false); assert.equal(moveItem(rows, 0, 9), false);
});
test('checks run a few at a time, in order', async () => {
  let running = 0, most = 0; const seen = [];
  await eachAtOnce([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++; most = Math.max(most, running); seen.push(n);
    await new Promise(r => setTimeout(r, 5)); running--;
  });
  assert.equal(most, 3); assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
});
test('the wheel scrolls a long list and zooms the graph only when there is nothing to scroll', () => {
  const long = {scrollHeight: 900, clientHeight: 400}, short = {scrollHeight: 400, clientHeight: 400};
  assert.equal(wheelScrollsList({deltaY: 100}, long), true);
  assert.equal(wheelScrollsList({deltaY: -100}, long), true);  // At the top too: no zoom halfway through.
  assert.equal(wheelScrollsList({deltaY: 100}, short), false);
  assert.equal(wheelScrollsList({deltaY: 100, ctrlKey: true}, long), false);  // A pinch still zooms.
  assert.equal(wheelPixels({deltaY: 3, deltaMode: 1}, 400), 120); assert.equal(wheelPixels({deltaY: 1, deltaMode: 2}, 400), 400);
  assert.equal(wheelPixels({deltaY: 53, deltaMode: 0}, 400), 53);
});
test('the status column holds a short word and never a size', () => {
  const shown = [undefined, {state:'missing', size:5e9}, {state:'queued'}, {state:'downloading', progress:42, downloaded:5e8, total:1e9},
    {state:'downloading', progress:null}, {state:'installed', size:5e9}, {state:'auth_required'}, {state:'error'}, {state:'cancelled'}, {state:'checking'}].map(rowStatus);
  assert.deepEqual(shown, ['Not checked', 'Missing', 'Queued', '42%', 'Starting…', 'Installed', 'Needs key', 'Failed', 'Cancelled', 'Checking…']);
  for (const text of shown) assert.ok(text.length <= 11 && !/[KMG]?B\b/.test(text), text);
});
