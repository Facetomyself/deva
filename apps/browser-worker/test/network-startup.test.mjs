import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { observeNetworkRestarts } from '../src/engine/network-startup.mjs';
import { EngineError } from '../src/engine/policy.mjs';

const phrase='Network service crashed or was terminated, restarting service.';
const line=(location=':656')=>`[fixture:ERROR:content/browser/network_service_instance_impl.cc${location}] ${phrase}\n`;

test('startup counts only the bounded Chromium network-service signature and retains no arbitrary bytes',()=>{
  const stream=new PassThrough(); const observer=observeNetworkRestarts(stream);
  stream.write('[unrelated.cc:656] '+phrase+'\n');
  stream.write(line(':private')); stream.write(line(':1111111111'));
  const good=line(':81')+line('(933)');
  for(const byte of Buffer.from(good))stream.write(Buffer.from([byte]));
  assert.equal(observer.stop(),2);
  stream.write(line()); assert.equal(observer.stop(),2);
  assert.equal(stream.listenerCount('data'),0);stream.destroy();
  assert.equal(new EngineError('BROWSER_TIMEOUT',{networkRestarts:5}).diagnostic.networkRestarts,5);
  for(const value of [-1,33,1.5,'private file'])assert.equal(new EngineError('BROWSER_TIMEOUT',{networkRestarts:value}).diagnostic,undefined);
});

test('network restart evidence saturates and ignores new messages after the byte budget',()=>{
  const a=new PassThrough(), b=new PassThrough(), high=observeNetworkRestarts(a), bytes=observeNetworkRestarts(b);
  a.write(line().repeat(100));assert.equal(high.stop(),32);
  b.write(Buffer.alloc(256*1024,120));b.write(line());assert.equal(bytes.stop(),0);
  a.destroy();b.destroy();
});
