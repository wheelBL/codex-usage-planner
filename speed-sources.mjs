import {createHash} from 'node:crypto';

export function speedSources(input=[]) {
 if(!Array.isArray(input)||input.length>8)throw new Error('SSH 主机最多8台');
 const ids=new Set(),targets=new Set();
 return input.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('无效 SSH 配置');
  const target=typeof item.target==='string'?item.target.trim():'';
  if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:\[\]-]{0,254}$/.test(target))throw new Error('SSH 目标请填写主机别名或 user@host，不要填写整条命令');
  const port=item.port??null;
  if(port!==null&&(!Number.isInteger(port)||port<1||port>65535))throw new Error('SSH 端口须为1–65535，留空沿用 SSH 配置');
  const home=typeof item.home==='string'?item.home.trim():'';
  if(home.length>512||/[\x00-\x1f\x7f]/.test(home)||home&&!/^(?:\/|~\/)/.test(home))throw new Error('远端 Codex 目录请填写绝对路径或 ~/ 开头的路径');
  const python=item.python??'python3';
  if(typeof python!=='string'||python.length>256||! /^(?:\/[^\x00-\x1f\x7f]+|[a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.test(python))throw new Error('Python 请填写可执行文件名或绝对路径');
  const endpoint=JSON.stringify([target,port,home]);
  const id=item.id??'ssh-'+createHash('sha256').update(endpoint).digest('hex').slice(0,16);
  if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(id)||id==='local'||ids.has(id)||targets.has(endpoint))throw new Error('SSH 主机标识或连接目标重复');
  const label=(typeof item.label==='string'?item.label.trim():'')||target;
  if(label.length>80||/[\x00-\x1f\x7f]/.test(label))throw new Error('主机名称最多80字');
  ids.add(id);targets.add(endpoint);
  return {id,label,target,port,home,python,enabled:item.enabled!==false};
 });
}
