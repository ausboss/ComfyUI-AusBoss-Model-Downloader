import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanList, cleanRow, cleanUrl, noteModel, rowKey, statusText} from '../js/shared/models.mjs';
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
