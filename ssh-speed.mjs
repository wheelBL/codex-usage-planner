import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {ResponseMeter,LocalSpeedReader} from './tps.mjs';
import {speedSources} from './speed-sources.mjs';

const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function sshSpeedArgs(source){
 const [s]=speedSources([source]);
 return ['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2',...(s.port===null?[]:['-p',String(s.port)]),s.target,`${quote(s.python)} -u - ${quote(s.home)}`];
}
function failure(stderr,code){
 if(code==='ENOENT')return '未找到 OpenSSH 客户端，请安装 ssh 并加入 PATH';
 if(/host key verification failed|remote host identification has changed/i.test(stderr))return 'SSH 主机密钥尚未确认或已变更，请先在终端核验连接';
 if(/permission denied|authentication failed/i.test(stderr))return 'SSH 登录失败；请先在终端配置密钥或 ssh-agent，无需向本软件提供密码';
 if(/python.*(?:not found|not recognized)|no such file.*python/i.test(stderr))return '远端没有 Python 3，请安装或填写其可执行文件路径';
 if(/could not resolve|name or service not known/i.test(stderr))return 'SSH 主机地址或别名无法解析';
 if(/timed out|connection refused|no route to host/i.test(stderr))return 'SSH 主机暂不可达，将自动重连';
 return 'SSH 采集连接已断开，将自动重连';
}
const translate=(s,offset)=>({...s,lastAt:s.lastAt? s.lastAt+offset:0,
 last:s.last?{...s.last,at:s.last.at+offset,recordedAt:s.last.recordedAt+offset,remoteAt:s.last.at}:null,
 recent:s.recent.map(x=>({...x,at:x.at+offset}))});

export class SSHSpeedReader {
 constructor(source,{now=()=>Date.now(),spawnImpl=spawn,helper=()=>readFile(new URL('./ssh-speed-helper.py',import.meta.url),'utf8')}={}){
  this.source=source;this.now=now;this.spawnImpl=spawnImpl;this.helper=helper;
  this.files=new Map();this.child=null;this.closed=false;this.retry=null;this.starting=false;this.status='connecting';this.error=null;this.checkedAt=null;this.offset=0;this.attempt=0;this.truncated=false;
 }
 async start(){
  if(this.closed||this.child||this.starting)return;
  this.starting=true;this.status='connecting';this.error=null;
  try{
   const script=await this.helper();if(this.closed)return;
   const child=this.spawnImpl('ssh',sshSpeedArgs(this.source),{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
   this.child=child;this.checkedAt=null;let tail=Buffer.alloc(0),stderr='',ended=false,firstTick=true;const refreshed=new Set();
   const finish=(message)=>{
    if(ended)return;ended=true;clearInterval(health);this.child=null;
    if(this.closed)return;
    this.status='error';this.error=message;const delay=Math.min(60000,2000*2**Math.min(this.attempt++,5));
    this.retry=setTimeout(()=>{this.retry=null;this.start();},delay);this.retry.unref?.();
   };
   const health=setInterval(()=>{if(this.now()-(this.checkedAt??started)>12000){finish('SSH 日志采集未更新，将自动重连');child.kill();}},1000);health.unref?.();
   const started=this.now();
   child.stdout.on('data',chunk=>{
    if(ended)return;tail=Buffer.concat([tail,Buffer.from(chunk)]);let at;
    try{
     while((at=tail.indexOf(10))>=0){if(at>131072)throw new Error();const line=tail.subarray(0,at);tail=tail.subarray(at+1);const event=JSON.parse(line.toString());if(event.type==='reset')refreshed.add(event.file);if(firstTick&&event.type==='tick'){for(const file of this.files.keys())if(!refreshed.has(file))this.files.delete(file);firstTick=false;}this.accept(event);}
     if(tail.length>131072)throw new Error();
    }catch{finish(this.error||'SSH 采集数据格式异常，将自动重连');child.kill();}
   });
   child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4096);});
   child.once('error',e=>finish(failure(stderr,e.code)));
   child.once('close',()=>finish(failure(stderr)));
   child.stdin.on('error',()=>{});child.stdin.end(script);
  }catch{this.status='error';this.error='SSH 采集程序不可用，请重新构建应用';}
  finally{this.starting=false;}
 }
 accept(event){
  if(event?.type==='tick'){
   if(!Number.isFinite(event.at)||event.at<=0)throw new Error('invalid remote clock');
   this.offset=this.now()-event.at;this.checkedAt=this.now();this.status='ready';this.error=null;this.truncated=event.truncated===true;this.attempt=0;return;
  }
  if(event?.type==='error'){this.error='远端 sessions 目录无读取权限';throw new Error(this.error);}
  if(typeof event?.file!=='string'||event.file.length>512)throw new Error('invalid file');
  if(event.type==='drop'){this.files.delete(event.file);return;}
  if(event.type==='reset'){if(!this.files.has(event.file)&&this.files.size>=24)throw new Error('too many files');this.files.set(event.file,new ResponseMeter());return;}
  const meter=this.files.get(event.file);if(!meter)throw new Error('missing file boundary');
  if(event.type==='record')meter.feed(event.record);
  else if(event.type==='unreadable')meter.reject(event.reason==='oversized'?'单条记录过大，已跳过':'远端日志暂不可读或记录不完整');
  else throw new Error('invalid event');
 }
 info(){return {id:this.source.id,kind:'ssh',label:this.source.label,connected:this.status==='ready'&&this.checkedAt!==null&&this.now()-this.checkedAt<=10000,checkedAt:this.checkedAt,status:this.status,error:this.error};}
 snapshot(selected=null){
  const sessions=[...this.files.values()].map(m=>translate(m.view(this.now()-this.offset),this.offset)).filter(s=>s.session&&s.model!=='codex-auto-review').sort((a,b)=>b.lastAt-a.lastAt);
  const seen=new Set(),unique=sessions.filter(s=>{if(seen.has(s.session))return false;seen.add(s.session);return true;});
  const chosen=selected?unique.find(s=>s.session===selected):unique.find(s=>!s.agent)||unique[0];
  return {checkedAt:this.checkedAt,coverage:`SSH ${this.source.label}：按最近活动读取最多24个会话；新会话或旧会话续聊约5秒内发现。${this.truncated?'目录较多，发现范围尚不完整。':''}`,selected:chosen||null,sessions:unique.map(({session,parent,agent,model,effort,lastAt})=>({session,parent,agent,model,effort,lastAt}))};
 }
 close(){this.closed=true;clearTimeout(this.retry);this.child?.kill();this.child=null;}
}

export class SpeedReader {
 constructor({local=new LocalSpeedReader(),remoteFactory=source=>new SSHSpeedReader(source),now=()=>Date.now()}={}){this.local=local;this.remoteFactory=remoteFactory;this.now=now;this.remotes=new Map();this.config=[];}
 configure(input=[]){
  const next=speedSources(input);this.config=next;
  const wanted=new Map(next.filter(s=>s.enabled).map(s=>[s.id,s]));
  for(const [id,reader]of this.remotes){const target=wanted.get(id);if(!target||JSON.stringify([target.target,target.port,target.home,target.python])!==JSON.stringify([reader.source.target,reader.source.port,reader.source.home,reader.source.python])){reader.close();this.remotes.delete(id);}}
  for(const [id,source]of wanted){let reader=this.remotes.get(id);if(!reader){reader=this.remoteFactory(source);this.remotes.set(id,reader);reader.start();}else reader.source=source;}
 }
 update(){return this.local.update();}
 snapshot(selection=null){
  const local=this.local.snapshot(),localInfo={id:'local',kind:'local',label:'本机',connected:local.checkedAt!==null&&this.now()-local.checkedAt<=10000,checkedAt:local.checkedAt,status:'ready',error:null};
  const readers=[{reader:this.local,data:local,info:localInfo},...[...this.remotes.values()].map(reader=>({reader,data:reader.snapshot(),info:reader.info()}))];
  const key=(info,session)=>`${info.id}|${session}`;
  const sessions=readers.flatMap(({data,info})=>data.sessions.map(s=>({...s,key:key(info,s.session),source:info}))).sort((a,b)=>b.lastAt-a.lastAt);
  let chosen=selection?sessions.find(s=>s.key===selection)||sessions.find(s=>s.source.id==='local'&&s.session===selection):sessions.find(s=>!s.agent&&s.source.connected)||sessions.find(s=>s.source.connected);
  if(!selection&&!chosen)chosen=sessions.find(s=>!s.agent)||sessions[0];
  let selected=null;
  if(chosen){const owner=readers.find(r=>r.info.id===chosen.source.id);const detail=owner.reader.snapshot(chosen.session).selected;if(detail)selected={...detail,key:chosen.key,source:owner.info};}
  const sources=[localInfo,...this.config.map(s=>this.remotes.get(s.id)?.info()||{id:s.id,kind:'ssh',label:s.label,connected:false,checkedAt:null,status:'disabled',error:null})];
  return {checkedAt:this.now(),selected,sessions,sources,missingSelection:!!selection&&!selected,coverage:readers.map(r=>r.data.coverage).join(' ')};
 }
 close(){this.local.close();for(const r of this.remotes.values())r.close();}
}
