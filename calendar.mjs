export const DAY = 86400000;
export const HOLIDAY_SOURCE = 'https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html';
const vacations = [['2026-01-01','2026-01-03','元旦'],['2026-02-15','2026-02-23','春节'],['2026-04-04','2026-04-06','清明'],['2026-05-01','2026-05-05','劳动节'],['2026-06-19','2026-06-21','端午'],['2026-09-25','2026-09-27','中秋'],['2026-10-01','2026-10-07','国庆']];
const makeup = new Set(['2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']);
const formatters = new Map();
export function dateKey(at, zone='Asia/Shanghai') {
 if (!formatters.has(zone)) formatters.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}));
 const p=Object.fromEntries(formatters.get(zone).formatToParts(at).map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day;
}
export function midnight(date,zone='Asia/Shanghai') {
 const [y,m,d]=date.split('-').map(Number), target=Date.UTC(y,m-1,d);let guess=target;
 const f=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 for(let i=0;i<4;i++){const p=Object.fromEntries(f.formatToParts(guess).map(x=>[x.type,x.value]));const observed=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);const delta=target-observed;if(!delta)return guess;guess+=delta;}
 throw new Error('无法确定该时区的午夜，请选择无午夜跳变的计划时区');
}
export function dayInfo(date,config) {
 if(Object.hasOwn(config.dayOverrides||{},date))return {weight:config.dayOverrides[date],reason:'自定义',verified:true};
 if(config.calendar==='china'&&date.startsWith('2026-')){
   if(makeup.has(date))return {weight:1,reason:'调休上班',verified:true};
   const vacation=vacations.find(([a,b])=>date>=a&&date<=b);if(vacation)return {weight:config.restWeight,reason:vacation[2],verified:true};
 }
 const weekday=new Date(date+'T12:00:00Z').getUTCDay();
 return {weight:weekday===0||weekday===6?config.restWeight:1,reason:weekday===0||weekday===6?'周末':'工作日',verified:config.calendar!=='china'||date.startsWith('2026-')};
}
export function makeClock(from,to,config) {
 const zone=config.calendarTimezone||'Asia/Shanghai', rows=[];let key=dateKey(from,zone),cursor=midnight(key,zone),sum=0;
 while(cursor<to){const nextKey=new Date(Date.parse(key+'T12:00:00Z')+DAY).toISOString().slice(0,10);const end=midnight(nextKey,zone),info=dayInfo(key,config);rows.push({date:key,start:cursor,end,prefix:sum,...info});sum+=info.weight;cursor=end;key=nextKey;}
 function at(t){if(t<=rows[0].start)return 0;if(t>=rows.at(-1).end)return sum;let l=0,r=rows.length-1;while(l<r){const m=Math.ceil((l+r)/2);if(rows[m].start<=t)l=m;else r=m-1;}const row=rows[l];return row.prefix+row.weight*(t-row.start)/(row.end-row.start);}
 return {rows,work:(a,b)=>Math.max(0,at(b)-at(a))};
}
