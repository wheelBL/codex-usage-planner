import test from 'node:test';
import assert from 'node:assert/strict';
import {createSerialQueue} from '../serial.mjs';
test('disk state mutations are ordered and recover after a failed write',async()=>{
 const enqueue=createSerialQueue(),events=[];let release;
 const gate=new Promise(resolve=>release=resolve);
 const first=enqueue(async()=>{events.push('first-start');await gate;events.push('first-end');throw new Error('disk full');});
 const second=enqueue(async()=>{events.push('second');return 'saved';});
 const failed=assert.rejects(first,/disk full/);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['first-start']);release();
 await failed;assert.equal(await second,'saved');assert.deepEqual(events,['first-start','first-end','second']);
});
