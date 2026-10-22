import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient,createLatestRead} from '../public/client.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('poll reads coalesce and a cancelled response cannot overwrite a newer state',async()=>{
 const requests=[],values=[],errors=[];
 const loader=createLatestRead({read:signal=>{const task=deferred();requests.push({...task,signal});return task.promise;},onData:x=>values.push(x),onError:x=>errors.push(x)});
 const old=loader.load();assert.equal(loader.load(),old);await tick();assert.equal(requests.length,1);
 const next=loader.load({replace:true});await tick();assert.equal(requests[0].signal.aborted,true);
 requests[1].resolve('current');await next;requests[0].resolve('old');await old;
 assert.deepEqual(values,['current']);assert.deepEqual(errors,[]);
 const failed=loader.load();await tick();requests[2].reject(new Error('offline'));await failed;assert.equal(errors.length,1);
 const recovered=loader.load();await tick();requests[3].resolve('recovered');await recovered;assert.equal(values.at(-1),'recovered');
});

test('mutation invalidation suppresses late read errors as well as values',async()=>{
 const task=deferred(),errors=[];
 const loader=createLatestRead({read:()=>task.promise,onData:()=>assert.fail('stale read'),onError:e=>errors.push(e)});
 const pending=loader.load();await tick();loader.cancel();task.reject(new Error('late error'));await pending;
 assert.deepEqual(errors,[]);
});

test('API deadlines include response bodies and allow a later retry',async()=>{
 let calls=0;
 const request=createApiClient({token:'test',readTimeout:10,fetchImpl:async(_url,{signal})=>{
  if(++calls>1)return {ok:true,status:200,json:async()=>({recovered:true})};
  return {ok:true,status:200,json:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))};
 }});
 await assert.rejects(request('state'),/超时/);
 assert.deepEqual(await request('state'),{recovered:true});
});

test('API distinguishes expired credentials, malformed JSON, and validation errors',async()=>{
 for(const [response,pattern]of [[{status:403},/凭据已失效/],[{status:200,ok:true,json:async()=>{throw new SyntaxError();}},/无效数据/],[{status:400,ok:false,json:async()=>({error:'无效工作时段'})},/无效工作时段/]]){
  const request=createApiClient({token:'test',fetchImpl:async()=>response});await assert.rejects(request('settings',{}),pattern);
 }
});

test('API preserves cancellation, authentication, body and query parameters',async()=>{
 let captured;
 const request=createApiClient({token:'page-token',fetchImpl:async(url,options)=>{captured={url,...options};return {ok:true,status:200,json:async()=>({})};}});
 const controller=new AbortController();controller.abort();await request('settings',{timezone:'UTC'},{signal:controller.signal,params:{days:30}});
 assert.equal(captured.signal.aborted,true);assert.equal(captured.url,'/api/settings?days=30');assert.equal(captured.method,'POST');assert.equal(captured.headers['X-Planner-Token'],'page-token');assert.equal(JSON.parse(captured.body).timezone,'UTC');
});
