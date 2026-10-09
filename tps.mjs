// Effective response throughput, inspired by adenta/codex-tps (MIT).
// No conversation text is retained. Missing/ambiguous timing is not guessed.
import {open,stat,opendir} from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const number=n=>Number.isSafeInteger(n)&&n>=0;
const generated=p=>p.type==='reasoning'||p.type==='message'&&p.role==='assistant'||['function_call','custom_tool_call'].includes(p.type);
const input=p=>['function_call_output','custom_tool_call_output','agent_message'].includes(p.type)||p.type==='message'&&['user','developer','system'].includes(p.role);
export class ResponseMeter {
 constructor(){this.samples=[];this.seen=new Set();this.pendingCalls=new Set();this.state='unknown';this.reason='尚无可测响应';this.model=null;this.effort=null;this.session=null;this.parent=null;this.start=null;this.end=null;this.turn=null;this.endedTurn=null;this.total=null;this.lastAt=0;this.activityAt=0;this.usageRecord=false;this.started=false;this.invalid=false;}
 resetWindow(at=null){this.start=at;this.end=null;this.invalid=false;}
 reject(reason){this.reason=reason;this.state='unmeasurable';this.resetWindow();}
 feed(r){
  const p=r?.payload||{},t=Date.parse(r?.timestamp),type=p.type;
  if(!Number.isFinite(t)){this.invalid=true;return;}
  if(t<this.lastAt){this.reject('日志时间倒退，等待新的响应边界');return;}this.lastAt=t;
  if(r.type==='turn_context'||r.type==='token_usage_record'||r.type==='response_item'&&(generated(p)||input(p))||r.type==='event_msg'&&['task_started','task_complete','user_message','turn_aborted','task_aborted','token_count'].includes(type))this.activityAt=t;
  if(r.type==='session_meta'){this.session=p.id||p.session_id||null;this.parent=p.parent_thread_id||null;this.agent=!!this.parent||!!p.source?.subagent;return;}
  if(r.type==='turn_context'){if(this.end&&(this.model!==p.model||this.effort!==p.effort))this.invalid=true;this.model=p.model??null;this.effort=p.effort??null;this.turn=p.turn_id||this.turn;if(this.end===null&&!this.pendingCalls.size)this.start=t;return;}
  if(r.type==='event_msg'&&type==='task_started'){this.started=true;this.turn=p.turn_id||null;this.pendingCalls.clear();this.resetWindow(t);this.state='generating';return;}
  if(r.type==='event_msg'&&['turn_aborted','task_aborted','error','stream_error'].includes(type)){this.pendingCalls.clear();this.endedTurn=p.turn_id||this.turn;this.reject('响应中断或重试，未计算本次速度');this.started=false;return;}
  if(r.type==='event_msg'&&type==='task_complete'){this.endedTurn=p.turn_id||this.turn;this.state='idle';this.started=false;this.resetWindow();return;}
  if(r.type==='event_msg'&&type==='user_message'){if(this.end!==null)this.invalid=true;else this.start=t;return;}
  if(r.type==='response_item'){
   if(generated(p)){
    if(this.pendingCalls.size&&this.end===null)this.invalid=true;
    this.end=t;this.state='generating';
    if(['function_call','custom_tool_call'].includes(type)){if(p.call_id)this.pendingCalls.add(p.call_id);else this.invalid=true;}
   }else if(input(p)){
    if(this.end!==null){this.invalid=true;return;} // Legacy delayed usage spanning tool execution is ambiguous.
    if(type.endsWith('_output')){if(!p.call_id||!this.pendingCalls.delete(p.call_id))this.invalid=true;}
    if(!this.pendingCalls.size){this.start=t;this.state=this.started?'generating':'unknown';}else this.state='tool';
   }else if(type?.endsWith('_call'))this.invalid=true;
   return;
  }
  const direct=r.type==='token_usage_record', legacy=r.type==='event_msg'&&type==='token_count';
  if(!direct&&!legacy)return;
  if(legacy&&this.usageRecord)return; // Modern records have explicit response identity; do not count their mirror.
  if(direct)this.usageRecord=true;
  const usage=direct?p.usage:p.info?.last_token_usage,total=direct?p.thread_token_usage?.output_tokens:p.info?.total_token_usage?.output_tokens;
  const id=direct?p.response_id:null;
  if(direct&&(!id||p.session_id&&this.session&&p.session_id!==this.session)){this.reject('用量缺少响应标识或属于其他会话');return;}
  if(id&&this.seen.has(id))return;
  // A bounded tail may start mid-turn. An identified completed response provides
  // a boundary for the NEXT response; never invent the missing first duration.
  if(direct&&p.turn_id&&!this.started&&p.turn_id!==this.endedTurn){
   if(this.turn!==p.turn_id){this.model=null;this.effort=null;}
   this.turn=p.turn_id;this.started=true;
  }
  if(id){this.seen.add(id);if(this.seen.size>2048)this.seen.delete(this.seen.values().next().value);}
  if(number(total)&&this.total!==null&&total<=this.total){if(total===this.total)return;this.total=total;this.reject('累计计数重置，等待下一响应');return;}
  const prior=this.total;if(number(total))this.total=total;
  const output=usage?.output_tokens,reasoning=usage?.reasoning_output_tokens;
  let reason=null;
  if(!this.started||this.start===null||this.end===null||this.invalid)reason='响应时间边界不完整或包含未分离的工具执行';
  else if(!number(output)||output===0)reason='输出 token 缺失或为零';
  else if(reasoning!=null&&(!number(reasoning)||reasoning>output))reason='推理 token 与输出 token 矛盾';
  else if(prior!==null&&number(total)&&total-prior!==output)reason='单次用量与累计增量不一致';
  else if(!direct&&!number(total))reason='旧格式缺少累计计数，无法去重';
  const seconds=(this.end-this.start)/1000;
  if(!reason&&(!(seconds>0)||seconds>3600))reason='响应时长不可解释';
  if(reason){this.reject(reason);}else{
   const sample={id:id||`${this.turn}:${total}`,session:this.session,turn:this.turn,model:this.model,effort:this.effort,at:this.end,recordedAt:t,seconds,output,reasoning:reasoning??null,visible:reasoning==null?null:output-reasoning,tps:output/seconds};
   this.samples.push(sample);if(this.samples.length>100)this.samples.shift();this.reason=null;this.state='completed';
  }
  this.resetWindow(this.pendingCalls.size?null:t);if(this.pendingCalls.size)this.state='tool';
 }
 view(now){
  const last=this.samples.at(-1)||null;
  const matching=last?this.samples.filter(x=>x.model===last.model&&x.effort===last.effort).slice(-7):[];
  const sorted=matching.map(s=>s.tps).sort((a,b)=>a-b),n=sorted.length;
  return {session:this.session,parent:this.parent,agent:!!this.agent,model:this.model,effort:this.effort,status:now-this.activityAt>120000?'idle':this.state,reason:this.reason,last,old:last?now-last.at>300000:true,median:n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:null,weighted:n?matching.reduce((a,s)=>a+s.output,0)/matching.reduce((a,s)=>a+s.seconds,0):null,count:n,recent:matching.map(s=>({at:s.at,tps:s.tps})),lastAt:this.activityAt};
 }
}
export class LocalSpeedReader {
 constructor({home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),now=()=>Date.now(),maxFiles=24,maxEntries=20000,watchFactory=watch}={}){
  this.home=home;this.now=now;this.maxFiles=maxFiles;this.maxEntries=maxEntries;this.files=new Map();this.catalog=new Map();this.discoveredAt=null;this.scan=null;this.warning=null;this.changed=new Set();this.watcher=null;this.watchFactory=watchFactory;this.closed=false;this.truncated=false;this.checkedAt=null;
 }
 startWatching(){
  if(this.watcher||!this.watchFactory||this.closed)return;
  try{this.watcher=this.watchFactory(path.join(this.home,'sessions'),{recursive:true,persistent:false},(_event,name)=>this.noteChange(name));this.watcher.on('error',()=>{this.watcher?.close();this.watcher=null;this.discoveredAt=null;});}catch{/* Periodic metadata discovery also works when recursive watching is unavailable. */}
 }
 noteChange(name){
  if(!name){this.discoveredAt=null;return;}
  const root=path.resolve(this.home,'sessions'),file=path.resolve(root,String(name));
  if(!file.startsWith(root+path.sep))return;
  if(!file.endsWith('.jsonl')){this.discoveredAt=null;return;}
  if(this.changed.size>=4096){this.changed.clear();this.discoveredAt=null;}else this.changed.add(file);
 }
 close(){this.closed=true;this.watcher?.close();this.watcher=null;}
 async discover(){
  this.startWatching();
  const now=this.now(),full=this.discoveredAt===null||now-this.discoveredAt>=60000;
  if(full){
   this.discoveredAt=now;const found=new Map();let count=0;this.truncated=false;
   // Discover by file activity across creation dates. Only metadata is scanned;
   // conversation contents are read from bounded tails of the selected files.
   const walk=async(dir,depth)=>{
    let entries;try{entries=await opendir(dir);}catch{return;}
    for await(const entry of entries){
     if(++count>this.maxEntries){this.truncated=true;break;}
     const file=path.join(dir,entry.name);
     if(entry.isDirectory()&&depth<3&&/^\d{2,4}$/.test(entry.name))await walk(file,depth+1);
     else if(entry.isFile()&&entry.name.endsWith('.jsonl')){const info=await stat(file).catch(()=>null);if(info)found.set(file,{mtimeMs:info.mtimeMs});}
     if(this.truncated)break;
    }
   };
   await walk(path.join(this.home,'sessions'),0);this.catalog=found;
  }
  const changed=[...this.changed];this.changed.clear();
  for(const file of changed){const info=await stat(file).catch(()=>null);if(info?.isFile())this.catalog.set(file,{mtimeMs:info.mtimeMs});else this.catalog.delete(file);}
  // Refresh already-covered mtimes even without filesystem watch support.
  for(const file of this.files.keys()){const info=await stat(file).catch(()=>null);if(info)this.catalog.set(file,{mtimeMs:info.mtimeMs});else this.catalog.delete(file);}
  const ranked=[...this.catalog].sort((a,b)=>b[1].mtimeMs-a[1].mtimeMs);
  // Bound metadata memory after a storm of watcher events.
  if(ranked.length>this.maxEntries)this.catalog=new Map(ranked.slice(0,this.maxEntries));
  const selected=ranked.slice(0,this.maxFiles),keep=new Set(selected.map(([file])=>file));
  for(const file of this.files.keys())if(!keep.has(file))this.files.delete(file);
  for(const [file]of selected)if(!this.files.has(file))this.files.set(file,{offset:0,tail:Buffer.alloc(0),skip:false,identity:null,meter:new ResponseMeter()});
  this.warning=ranked.length?`本机来源按最近活动读取最多${this.maxFiles}个会话日志，包含旧会话续聊；不代表当前选中任务，归档不在覆盖范围。${this.truncated?'目录较多，发现范围尚不完整。':''}${!this.watcher?'文件监听不可用，新会话最长约60秒发现。':''}`:'未发现本机会话日志；不代表账户没有活动。';
 }
 async update(){if(this.scan)return this.scan;this.scan=this.read().finally(()=>this.scan=null);return this.scan;}
 async read(){
  await this.discover();
  for(const [file,state]of this.files){
   let handle;
   try{
    const info=await stat(file),identity=`${info.dev}:${info.ino}`;
    if(state.identity!==identity||info.size<state.offset){state.offset=0;state.tail='';state.skip=false;state.meter=new ResponseMeter();state.identity=identity;}
    // Bootstrap only the last 2 MiB for a large file. Find session metadata in a small header, never retain text.
    handle=await open(file,'r');
    if(state.offset===0&&info.size>2*1024*1024){const header=Buffer.alloc(65536);const {bytesRead}=await handle.read(header,0,header.length,0);for(const line of header.subarray(0,bytesRead).toString().split('\n').slice(0,-1)){try{const r=JSON.parse(line);if(r.type==='session_meta')state.meter.feed(r);}catch{}}
     state.offset=info.size-2*1024*1024;state.skip=true;
    }
    const length=Math.min(2*1024*1024,info.size-state.offset);if(!length)continue;
    const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,state.offset);state.offset+=bytesRead;
    // Buffer bytes rather than decoded fragments to preserve UTF-8 split boundaries.
    state.tail=Buffer.concat([Buffer.isBuffer(state.tail)?state.tail:Buffer.from(state.tail),buffer.subarray(0,bytesRead)]);
    let at;
    while((at=state.tail.indexOf(10))>=0){const line=state.tail.subarray(0,at);state.tail=state.tail.subarray(at+1);if(state.skip){state.skip=false;continue;}try{state.meter.feed(JSON.parse(line.toString('utf8')));}catch{state.meter.reject('日志包含无法解析的记录');}}
    if(state.tail.length>1024*1024){state.tail=Buffer.alloc(0);state.skip=true;state.meter.reject('单条记录过大，已跳过');}
   }catch{state.meter.reject('日志暂不可读');}finally{await handle?.close();}
  }
  this.checkedAt=this.now();
 }
 snapshot(selected=null){
  const sessions=[...this.files.values()].map(f=>f.meter.view(this.now())).filter(s=>s.session&&s.model!=='codex-auto-review');
  // Separate child agents; never add their throughput to the parent.
  sessions.sort((a,b)=>b.lastAt-a.lastAt);
  const seen=new Set(),unique=sessions.filter(s=>{if(seen.has(s.session))return false;seen.add(s.session);return true;});
  const chosen=selected?unique.find(s=>s.session===selected):unique.find(s=>!s.agent)||unique[0];
  return {checkedAt:this.checkedAt,coverage:this.warning,selected:chosen||null,sessions:unique.map(({session,parent,agent,model,effort,lastAt})=>({session,parent,agent,model,effort,lastAt})),missingSelection:!!selected&&!chosen};
 }
}
