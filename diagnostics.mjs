export function safeErrorSummary(value){const s=String(value||'');if(/authorization|bearer|access_token|refresh_token|id_token|password|cookie/i.test(s))return '[认证相关内容已省略]';return s.replace(/https?:[^\s)"']+/g,'[url]').replace(/[A-Z]:\\[^\s]+/gi,'[path]').replace(/[\w.+-]+@[\w.-]+/g,'[email]').replace(/[A-Za-z0-9_=\/-]{24,}/g,'[redacted]').replace(/[\r\n\t]/g,' ').slice(0,300);}
// Only allowlisted error categories are persisted; never raw response bodies or credentials.
export function describeFailure(error,stage='network'){
 const text=String(error?.message||'').toLowerCase(),code=String(error?.cause?.code||error?.code||'');
 const status=Number(error?.status)||Number(text.match(/(?:http|status(?: code)?)[^0-9]{0,8}([45][0-9]{2})/)?.[1])||null;
 const category=status===401?'auth':status===403?'forbidden':status===429?'rate-limit':status>=500?'server':/timeout|timed out|deadline|time limit|operation.*cancel/.test(text)||error?.name==='TimeoutError'?'timeout':/certificate|tls|cert_/.test(text+code)?'tls':/enotfound|eai_again/.test(code.toLowerCase())?'dns':/fetch failed|connect|socket|network|econn|error sending request/.test(text+code)?'connection':/enoent|credentials|oauth unavailable/.test(text+code)?'credentials':'unknown';
 const signatures=['error sending request','failed to fetch','request failed','connection reset','connection refused','timed out','deadline exceeded','invalid token','token expired','refresh token','unexpected status','unexpected response','error decoding','body error','service unavailable'].filter(v=>text.includes(v));
 return {stage,category,status,signatures,detail:category==='unknown'?safeErrorSummary(error?.message):undefined,code:/^[A-Z][A-Z0-9_]{1,50}$/.test(code)?code:undefined,rpcCode:Number.isFinite(error?.rpcCode)?error.rpcCode:undefined};
}
export function failureLabel(d){return (d.status?'HTTP '+d.status+' · ':'')+({auth:'登录凭证被拒绝',forbidden:'请求被拒绝', 'rate-limit':'请求频率受限',server:'服务端暂时异常',timeout:'请求超时',tls:'TLS连接异常',dns:'域名解析失败',connection:'网络连接失败',credentials:'本机登录凭证不可用',unknown:'未分类错误'}[d.category]||'未分类错误')+(d.rpcCode?' (RPC '+d.rpcCode+')':'');}
export async function getWithRetry(url,options,{fetcher=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms)),onDiagnostic=()=>{},stage='oauth'}={}){
 for(let attempt=1;attempt<=2;attempt++){
  try{const response=await fetcher(url,{...options,signal:AbortSignal.timeout(10000)});if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('HTTP '+response.status),{status:response.status});}return response;}
  catch(error){const d=describeFailure(error,stage);await onDiagnostic({...d,attempt});if(attempt===2||!['timeout','connection','dns','server'].includes(d.category))throw Object.assign(new Error(failureLabel(d)),{diagnostic:d});await wait(750);}
 }
}
