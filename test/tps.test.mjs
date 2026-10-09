import test from 'node:test';
import assert from 'node:assert/strict';
import {ResponseMeter,LocalSpeedReader} from '../tps.mjs';
import {mkdtemp,mkdir,writeFile,appendFile,rm,utimes} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const base=Date.parse('2026-10-08T02:00:00Z');
const row=(s,type,payload)=>({timestamp:new Date(base+s*1000).toISOString(),type,payload});
function setup(){const m=new ResponseMeter();m.feed(row(0,'session_meta',{id:'s'}));m.feed(row(1,'event_msg',{type:'task_started',turn_id:'t'}));m.feed(row(1,'turn_context',{model:'m',effort:'high'}));return m;}
const usage=(s,id,output,total,reasoning)=>row(s,'token_usage_record',{response_id:id,session_id:'s',usage:{output_tokens:output,reasoning_output_tokens:reasoning},thread_token_usage:{output_tokens:total}});
test('explicit response identity deduplicates mirror; missing reasoning stays unknown',()=>{const m=setup();m.feed(row(3,'response_item',{type:'message',role:'assistant'}));m.feed(usage(3,'r',100,100));m.feed(usage(4,'r',100,100));m.feed(row(4,'event_msg',{type:'token_count',info:{last_token_usage:{output_tokens:100},total_token_usage:{output_tokens:100}}}));assert.equal(m.samples.length,1);assert.equal(m.samples[0].tps,50);assert.equal(m.samples[0].reasoning,null);assert.equal(m.samples[0].visible,null);});
test('separable parallel tool execution is excluded from subsequent response',()=>{const m=setup();m.feed(row(3,'response_item',{type:'custom_tool_call',call_id:'a'}));m.feed(row(3,'response_item',{type:'custom_tool_call',call_id:'b'}));m.feed(usage(3,'r',100,100,20));m.feed(row(20,'response_item',{type:'custom_tool_call_output',call_id:'a'}));m.feed(row(30,'response_item',{type:'custom_tool_call_output',call_id:'b'}));m.feed(row(32,'response_item',{type:'message',role:'assistant'}));m.feed(usage(32,'r2',60,160,10));assert.equal(m.samples.length,2);assert.equal(m.samples[1].seconds,2);assert.equal(m.samples[1].output,60);assert.equal(m.samples[1].visible,50);assert.equal(m.view(base+33000).weighted,40);});
test('contradictory reasoning, zero duration and interrupted responses are unmeasurable',()=>{for(const mode of ['reasoning','zero','abort']){const m=setup();m.feed(row(mode==='zero'?1:3,'response_item',{type:'message',role:'assistant'}));if(mode==='abort')m.feed(row(3,'event_msg',{type:'turn_aborted'}));m.feed(usage(4,'r',10,10,mode==='reasoning'?11:0));assert.equal(m.samples.length,0,mode);}});
test('counter resets reject the sample and model groups are separate',()=>{const m=setup();m.feed(row(3,'response_item',{type:'message',role:'assistant'}));m.feed(usage(3,'r',100,100,0));m.feed(row(4,'response_item',{type:'message',role:'assistant'}));m.feed(usage(4,'r2',10,10,0));assert.equal(m.samples.length,1);m.feed(row(5,'event_msg',{type:'task_started'}));m.feed(row(5,'turn_context',{model:'other',effort:'low'}));m.feed(row(7,'response_item',{type:'message',role:'assistant'}));m.feed(usage(7,'r3',50,60,0));assert.equal(m.view(base+8000).count,1);assert.equal(m.view(base+8000).median,25);});
test('legacy tool-spanning timing is rejected',()=>{const m=setup();m.feed(row(3,'response_item',{type:'custom_tool_call',call_id:'a'}));m.feed(row(30,'response_item',{type:'custom_tool_call_output',call_id:'a'}));m.feed(row(30,'event_msg',{type:'token_count',info:{last_token_usage:{output_tokens:100},total_token_usage:{output_tokens:100}}}));assert.equal(m.samples.length,0);});
test('incremental reader handles partial records, keeps sessions separate and resets after truncation',async()=>{const home=await mkdtemp(path.join(os.tmpdir(),'tps-'));try{const dir=path.join(home,'sessions/2026/10/08');await mkdir(dir,{recursive:true});const file=path.join(dir,'x.jsonl');const rows=[row(0,'session_meta',{id:'s'}),row(1,'event_msg',{type:'task_started'}),row(1,'turn_context',{model:'m'}),row(3,'response_item',{type:'message',role:'assistant',content:'不可持久化正文'}),usage(3,'r',100,100)];const data=rows.map(JSON.stringify).join('\n')+'\n';await writeFile(file,data.slice(0,-5));const reader=new LocalSpeedReader({home,now:()=>base+5000});await reader.update();assert.equal(reader.snapshot().selected.last,null);await appendFile(file,data.slice(-5));await reader.update();assert.equal(reader.snapshot().selected.last.output,100);await reader.update();assert.equal(reader.snapshot().selected.count,1);assert.equal(JSON.stringify(reader.snapshot()).includes('不可持久化正文'),false);assert.equal(reader.snapshot('absent').missingSelection,true);await writeFile(file,JSON.stringify(row(0,'session_meta',{id:'new'}))+'\n');await reader.update();assert.equal(reader.snapshot().selected.session,'new');assert.equal(reader.snapshot().selected.last,null);}finally{await rm(home,{recursive:true,force:true});}});

function sessionRows(id,end=3,model='m',agent=false){return [row(0,'session_meta',{id,...(agent?{parent_thread_id:'parent'}:{})}),row(end-2,'event_msg',{type:'task_started'}),row(end-2,'turn_context',{model}),row(end,'response_item',{type:'message',role:'assistant'}),{...usage(end,'response-'+id,100,100,0),payload:{...usage(end,'response-'+id,100,100,0).payload,session_id:id}}].map(JSON.stringify).join('\n')+'\n';}
test('old creation date and resumed conversations are discovered; housekeeping does not select a session',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'tps-old-'));const reader=new LocalSpeedReader({home,now:()=>base+50000,watchFactory:null});
 try{
  const old=path.join(home,'sessions/2025/01/01'),recent=path.join(home,'sessions/2026/10/08');await mkdir(old,{recursive:true});await mkdir(recent,{recursive:true});
  await writeFile(path.join(old,'old.jsonl'),sessionRows('resumed',30));
  await writeFile(path.join(recent,'new.jsonl'),sessionRows('new',10)+JSON.stringify(row(40,'event_msg',{type:'background_metadata'}))+'\n');
  await writeFile(path.join(recent,'agent.jsonl'),sessionRows('agent',45,'m',true));
  await reader.update();assert.equal(reader.snapshot().selected.session,'resumed');assert.equal(reader.snapshot('agent').selected.session,'agent');assert.equal(reader.snapshot().checkedAt,base+50000);
 }finally{reader.close();await rm(home,{recursive:true,force:true});}
});
test('watch event discovers an older file outside the current cap on the next tick',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'tps-watch-'));let changed,closed=false;
 const reader=new LocalSpeedReader({home,maxFiles:1,now:()=>base+50000,watchFactory:(_root,options,fn)=>{assert.equal(options.recursive,true);changed=fn;return {on(){},close(){closed=true;}};}});
 try{
  const dir=path.join(home,'sessions/2025/01/01');await mkdir(dir,{recursive:true});const a=path.join(dir,'a.jsonl'),b=path.join(dir,'b.jsonl');
  await writeFile(a,sessionRows('a',10));await writeFile(b,sessionRows('b',3));await utimes(a,20,20);await utimes(b,10,10);
  await reader.update();assert.equal(reader.snapshot().selected.session,'a');
  await appendFile(b,sessionRows('b',30));await utimes(b,30,30);changed('change',path.relative(path.join(home,'sessions'),b));
  await reader.update();assert.equal(reader.snapshot().selected.session,'b');assert.equal(reader.files.size,1);
  changed('change','../../outside.jsonl');assert.equal(reader.changed.size,0);
 }finally{reader.close();assert.equal(closed,true);await rm(home,{recursive:true,force:true});}
});
test('bounded tail catches up in one read and remains live on append',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'tps-tail-'));const reader=new LocalSpeedReader({home,now:()=>base+60000,watchFactory:null});
 try{
  const dir=path.join(home,'sessions/2025/01/01');await mkdir(dir,{recursive:true});const file=path.join(dir,'large.jsonl');
  await writeFile(file,JSON.stringify(row(0,'session_meta',{id:'large'}))+'\n'+JSON.stringify(row(0,'ignored',{padding:'x'.repeat(3*1024*1024)}))+'\n'+sessionRows('large',30));
  await reader.update();assert.equal(reader.snapshot().selected.last.output,100);assert.equal(reader.snapshot().selected.last.at,base+30000);
  await appendFile(file,JSON.stringify(row(35,'response_item',{type:'message',role:'assistant'}))+'\n'+JSON.stringify({...usage(35,'next',200,300,0),payload:{...usage(35,'next',200,300,0).payload,session_id:'large'}})+'\n');
  await reader.update();assert.equal(reader.snapshot().selected.last.output,200);assert.equal(reader.snapshot().selected.last.at,base+35000);
 }finally{reader.close();await rm(home,{recursive:true,force:true});}
});

test('mid-turn tail recovers only after a complete response boundary and never after abort',()=>{
 const m=new ResponseMeter();m.feed(row(0,'session_meta',{id:'s'}));
 const withTurn=(s,id,total)=>{const r=usage(s,id,100,total,0);r.payload.turn_id='continued';return r;};
 m.feed(row(10,'response_item',{type:'message',role:'assistant'}));m.feed(withTurn(10,'one',100));assert.equal(m.samples.length,0);
 m.feed(row(12,'response_item',{type:'message',role:'assistant'}));m.feed(withTurn(12,'two',200));assert.equal(m.samples[0].tps,50);assert.equal(m.samples[0].model,null);
 m.feed(row(13,'event_msg',{type:'turn_aborted',turn_id:'continued'}));m.feed(row(15,'response_item',{type:'message',role:'assistant'}));m.feed(withTurn(15,'three',300));assert.equal(m.samples.length,1);
});
