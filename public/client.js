export function createApiClient({token,fetchImpl=globalThis.fetch,readTimeout=8000,writeTimeout=60000}) {
  return async (route,value,{signal,params={},timeout=value===undefined?readTimeout:writeTimeout}={}) => {
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    let expired=false;
    const timer=setTimeout(()=>{expired=true;controller.abort();},timeout);
    try {
      const query=new URLSearchParams(params).toString();
      const response=await fetchImpl(`/api/${route}${query?'?'+query:''}`,{
        method:value===undefined?'GET':'POST',signal:controller.signal,
        headers:{'X-Planner-Token':token,'Content-Type':'application/json'},
        body:value===undefined?undefined:JSON.stringify(value)
      });
      if(response.status===403)throw new Error('连接凭据已失效，请重新打开面板；未保存的设置请先保留。');
      let result;
      try { result=await response.json(); }
      catch(error) { if(controller.signal.aborted)throw error;throw new Error('本机服务返回了无效数据，请重试或重新打开面板。'); }
      if(!response.ok)throw new Error(result?.error||`本机服务请求失败（${response.status}）`);
      return result;
    } catch(error) {
      if(expired)throw new Error(value===undefined?'连接超时，请重试。':'提交超时，结果尚未确认；请刷新核对后再重试。');
      if(error instanceof TypeError&&!signal?.aborted)throw new Error('无法连接本机服务，请确认程序仍在运行。');
      throw error;
    } finally {
      clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    }
  };
}

// Coalesce timer ticks; a range change or mutation invalidates older responses,
// even if a fetch implementation completes after its AbortSignal fires.
export function createLatestRead({read,onData,onError}) {
  let current=null,revision=0;
  function cancel(){revision++;current?.controller.abort();current=null;}
  function load({replace=false}={}) {
    if(replace)cancel();
    if(current)return current.promise;
    const version=revision,controller=new AbortController();
    const entry={controller,promise:null};current=entry;
    entry.promise=Promise.resolve().then(()=>read(controller.signal)).then(
      value=>{if(version===revision)onData(value);},
      error=>{if(version===revision&&!controller.signal.aborted)onError(error);}
    ).finally(()=>{if(current===entry)current=null;});
    return entry.promise;
  }
  return {load,cancel};
}
