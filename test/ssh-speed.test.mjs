import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {speedSources} from '../speed-sources.mjs';
import {settings} from '../core.mjs';
import {SSHSpeedReader,SpeedReader,sshSpeedArgs} from '../ssh-speed.mjs';
import {ResponseMeter,LocalSpeedReader} from '../tps.mjs';

const row=(at,type,payload)=>({timestamp:new Date(at).toISOString(),type,payload});
function rows(id,start=Date.now()-4000,output=100){return [
 row(start,'session_meta',{id}),row(start+1000,'event_msg',{type:'task_started',turn_id:'turn'}),
 row(start+1000,'turn_context',{model:'model',effort:'high',turn_id:'turn'}),
 row(start+1000,'response_item',{type:'message',role:'user',content:'PRIVATE_USER_TEXT'}),
 row(start+3000,'response_item',{type:'message',role:'assistant',content:'PRIVATE_ASSISTANT_TEXT'}),
 row(start+3000,'token_usage_record',{session_id:id,turn_id:'turn',response_id:'response-'+id,usage:{output_tokens:output,reasoning_output_tokens:20,input_tokens:1000},thread_token_usage:{output_tokens:output}})
 ];}
async function waitUntil(check,timeout=4000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for collector');await new Promise(r=>setTimeout(r,20));}}
function fakeChild(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.emit('close',null);};return child;}

test('SSH settings persist explicit sources, respect SSH port configuration and reject injected targets',()=>{
 const source={label:'v100',target:'user@host',home:"/home/user/Codex's data"};
 const normalized=settings({speedSources:[source]}).speedSources[0];
 assert.equal(normalized.enabled,true);assert.equal(normalized.port,null);assert.equal(normalized.python,'python3');
 assert.equal(speedSources([source])[0].id,normalized.id);
 const args=sshSpeedArgs(normalized);assert.equal(args.includes('-p'),false);assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.match(args.at(-1),/Codex'\\''s data/);
 assert.deepEqual(sshSpeedArgs({...normalized,port:40015}).slice(-4,-1),['-p','40015','user@host']);
 for(const bad of [{target:'-oProxyCommand=evil'},{target:'user@host;touch /tmp/evil'},{target:'host\nother'},{target:'host',port:0},{target:'host',home:'relative'},{target:'host',python:'python3; evil'}])assert.throws(()=>speedSources([bad]));
 assert.throws(()=>speedSources([source,source]),/重复/);assert.deepEqual(settings().speedSources,[]);
});

test('remote framing preserves partial UTF-8, keeps old samples on disconnect and closes retry work',async()=>{
 let child,args,options,spawnCount=0;
 const now=Date.now(),reader=new SSHSpeedReader(speedSources([{target:'host',label:'远端'}])[0],{now:()=>now,helper:async()=>'',spawnImpl:(_cmd,a,o)=>{spawnCount++;args=a;options=o;return child=fakeChild();}});
 try{
  await reader.start();assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(args.includes('BatchMode=yes'),true);
  const r=rows('s',now-4000);r[2].payload.model='模型🧪';const frames=[{type:'reset',file:'f'},...r.map(record=>({type:'record',file:'f',record})),{type:'tick',at:now,covered:1}].map(JSON.stringify).join('\n')+'\n';
  const bytes=Buffer.from(frames);const at=bytes.indexOf(Buffer.from('模型'))+1;child.stdout.write(bytes.subarray(0,at));child.stdout.write(bytes.subarray(at));
  assert.equal(reader.info().connected,true);assert.equal(reader.snapshot().selected.last.tps,50);assert.equal(reader.snapshot().selected.model,'模型🧪');
  child.stderr.write('Permission denied (publickey). DO_NOT_DISPLAY_RAW_STDERR');child.emit('close',255);
  assert.equal(reader.info().connected,false);assert.match(reader.info().error,/SSH 登录失败/);assert.equal(reader.snapshot().selected.last.tps,50);
  assert.equal(JSON.stringify(reader.snapshot()).includes('PRIVATE_'),false);assert.equal(JSON.stringify(reader.info()).includes('DO_NOT_DISPLAY_RAW_STDERR'),false);
  reader.close();assert.equal(reader.retry?.hasRef?.(),false);assert.equal(spawnCount,1);
 }finally{reader.close();}
});

test('real Python helper matches the local meter, strips content, handles partial append and truncation',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'ssh-tps-')),dir=path.join(home,'sessions/2024/01/01'),file=path.join(dir,'resumed.jsonl');await mkdir(dir,{recursive:true});
 const records=rows('resumed');await writeFile(file,records.map(JSON.stringify).join('\n')+'\n');
 let raw='',child;
 const reader=new SSHSpeedReader(speedSources([{target:'example.invalid',home}])[0],{spawnImpl:(_cmd,_args,opts)=>{
  child=spawn('python3',['-u','-',home],opts);child.stdout.on('data',chunk=>{raw+=chunk.toString();});return child;
 }});
 try{
  await reader.start();await waitUntil(()=>reader.info().connected||reader.status==='error');
  if(reader.error?.includes('未找到 OpenSSH')){t.skip('Python 3 unavailable for helper integration');return;}
  assert.equal(reader.info().connected,true,reader.error||'connected');
  const local=new ResponseMeter();for(const r of records)local.feed(r);
  assert.equal(reader.snapshot().selected.last.tps,local.view(Date.now()).last.tps);assert.equal(reader.snapshot().selected.last.output,100);
  assert.equal(raw.includes('PRIVATE_USER_TEXT'),false);assert.equal(raw.includes('PRIVATE_ASSISTANT_TEXT'),false);assert.equal(raw.includes('input_tokens'),false);
  const start=Date.now()-1000,end=start+500;
  const extra=[row(start,'event_msg',{type:'task_started',turn_id:'turn2'}),row(start,'turn_context',{model:'model',effort:'high'}),row(end,'response_item',{type:'message',role:'assistant',content:'秘密正文🧪'}),row(end,'token_usage_record',{response_id:'r2',session_id:'resumed',turn_id:'turn2',usage:{output_tokens:60},thread_token_usage:{output_tokens:160}})].map(JSON.stringify).join('\n')+'\n';
  await appendFile(file,extra.slice(0,-4));const checked=reader.checkedAt;await waitUntil(()=>reader.checkedAt>checked);assert.equal(reader.snapshot().selected.count,1);
  await appendFile(file,extra.slice(-4));await waitUntil(()=>reader.snapshot().selected?.count===2);assert.equal(reader.snapshot().selected.last.tps,120);assert.equal(raw.includes('秘密正文'),false);
  await writeFile(file,rows('replacement').map(JSON.stringify).join('\n')+'\n');await waitUntil(()=>reader.snapshot().selected?.session==='replacement');assert.equal(reader.snapshot().selected.count,1);
 }finally{reader.close();await rm(home,{recursive:true,force:true});}
});

test('all connected hosts participate; same session ID is isolated, clock skew does not change TPS, stale host falls back',async()=>{
 const localHome=await mkdtemp(path.join(os.tmpdir(),'tps-local-'));const dir=path.join(localHome,'sessions/2026/10/09');await mkdir(dir,{recursive:true});
 const now=Date.now();await writeFile(path.join(dir,'local.jsonl'),rows('same',now-6000,100).map(JSON.stringify).join('\n')+'\n');
 let time=now;const local=new LocalSpeedReader({home:localHome,now:()=>time,watchFactory:null});
 const manager=new SpeedReader({local,now:()=>time,remoteFactory:s=>{const r=new SSHSpeedReader(s,{now:()=>time});r.start=()=>{};return r;}});
 try{
  await manager.update();manager.configure([{id:'v100',target:'first',label:'v100'},{id:'v120',target:'second',label:'v120'}]);
  for(const [id,reader]of manager.remotes){
   reader.accept({type:'reset',file:'f'});
   const skew=id==='v100'?60000:-120000,at=now+skew;
   for(const record of rows('same',at-(id==='v100'?4500:4000),id==='v100'?80:60))reader.accept({type:'record',file:'f',record});
   reader.accept({type:'tick',at});
  }
  let data=manager.snapshot();assert.equal(data.sessions.length,3);assert.equal(data.selected.source.id,'v120');assert.equal(data.selected.last.tps,30);assert.ok(Math.abs(data.selected.last.at-(now-1000))<1);
  assert.equal(manager.snapshot('v100|same').selected.last.tps,40);assert.equal(manager.snapshot('local|same').selected.last.tps,50);assert.equal(manager.snapshot('same').selected.source.id,'local');assert.equal(manager.snapshot('unknown|same').missingSelection,true);
  manager.remotes.get('v120').status='error';assert.equal(manager.snapshot().selected.source.id,'v100');
  const offline=manager.snapshot('v120|same');assert.equal(offline.selected.source.connected,false);assert.equal(offline.selected.last.tps,30);
  time+=11000;await manager.update();assert.equal(manager.snapshot().selected.source.id,'local','stale remote heartbeat cannot mask a fresh local source');
  manager.configure([{id:'v100',target:'first',enabled:false}]);assert.equal(manager.remotes.size,0);assert.equal(manager.snapshot().sources.find(s=>s.id==='v100').status,'disabled');
 }finally{manager.close();await rm(localHome,{recursive:true,force:true});}
});

test('invalid remote protocol and oversized frames terminate a source without affecting local updates',async()=>{
 let child;const reader=new SSHSpeedReader(speedSources([{target:'host'}])[0],{helper:async()=>'',spawnImpl:()=>child=fakeChild()});
 try{await reader.start();child.stdout.write('not a JSON frame\n');assert.equal(reader.status,'error');assert.equal(reader.info().connected,false);}
 finally{reader.close();}
 const second=new SSHSpeedReader(speedSources([{target:'host'}])[0],{helper:async()=>'',spawnImpl:()=>child=fakeChild()});
 try{await second.start();child.stdout.write('x'.repeat(131073));assert.equal(second.status,'error');assert.equal(second.info().connected,false);}
 finally{second.close();}
});
