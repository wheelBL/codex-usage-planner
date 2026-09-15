// Network outages must not leave a recovered service unobserved for 15 minutes.
export function pollDelay(error){return /HTTP (401|403|429)\b/.test(error||'')?300000:60000;}
export function createPollScheduler(refresh,getError,{setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}={}){
 let timer=null,nextAt=null,stopped=false;
 function schedule(){if(stopped)return;if(timer!==null)clearTimer(timer);const delay=pollDelay(getError());nextAt=now()+delay;timer=setTimer(async()=>{timer=null;nextAt=null;await refresh();schedule();},delay);}
 return {schedule,get nextAt(){return nextAt;},stop(){stopped=true;if(timer!==null)clearTimer(timer);timer=null;nextAt=null;}};
}
