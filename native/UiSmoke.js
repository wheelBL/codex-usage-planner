// Runs only from the native --demo --smoke path, inside its own WebView2.
window.plannerSmoke={done:false};
(async()=>{
 const byId=id=>document.getElementById(id);
 const check=(condition,message)=>{if(!condition)throw new Error(message);};
 const waitFor=async(check)=>{const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw new Error('UI condition timed out');await new Promise(r=>setTimeout(r,25));}};
 const headers={'Content-Type':'application/json','X-Planner-Token':document.querySelector('meta[name=planner-token]').content};
 const snapshot=await (await fetch('/api/state',{headers})).json();
 check(snapshot.demo,'UI smoke requires --demo');
 await waitFor(()=>byId('actual').textContent!=='—'&&!byId('save-settings').disabled);
 await waitFor(()=>byId('speed-coverage').textContent.includes('演示模式'));
 check(!byId('live-speed-status').textContent.includes('连接中断'),'Demo speed requests failed');
 const original=snapshot.config;
 try{
  document.querySelector('[data-tab=settings]').click();
  byId('overrides').closest('details').open=true;
  byId('overrides').value='2026-10-22=0\n2026-10-22=1';
  byId('overrides').dispatchEvent(new Event('input',{bubbles:true}));
  check(byId('saved').textContent.includes('未保存'),'Missing dirty feedback');
  byId('settings').requestSubmit();
  await waitFor(()=>byId('overrides-error').textContent.includes('重复'));
  check(byId('hours-error').textContent==='','Unrelated error was attached to work hours');
  check(document.activeElement===byId('overrides'),'Invalid field did not receive focus');
  byId('overrides').value='';
  byId('settings').requestSubmit();
  check(byId('save-settings').disabled,'Save did not lock duplicate submission');
  await waitFor(()=>byId('saved').textContent==='已保存并更新计划');
  check(!byId('save-settings').disabled,'Save remained disabled');
  document.querySelector('[data-tab=plan]').click();
  await waitFor(()=>byId('daily-rows').children.length>0);
  document.querySelector('[data-tab=history]').click();
  byId('history-data').open=true;
  await waitFor(()=>byId('history-rows').children.length>0);
  check(byId('history-rows').children.length<=50,'History table is unbounded');
  check(byId('history-summary').textContent.includes('采样'),'History summary missing');
 }finally{
  const restored=await fetch('/api/settings',{method:'POST',headers,body:JSON.stringify(original)});
  check(restored.ok,'Failed to restore demo settings');
  document.querySelector('[data-tab=overview]').click();
  byId('refresh').click();
  await waitFor(()=>!byId('refresh').disabled);
 }
 window.plannerSmoke={done:true,passed:true,checks:['speed-request','dirty-feedback','duplicate-date-validation','error-focus','save-lock','save-success','plan-navigation','history-table','demo-restored']};
})().catch(error=>{window.plannerSmoke={done:true,passed:false,error:error.message};});
