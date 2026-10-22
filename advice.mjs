import {makeClock, DAY} from './calendar.mjs';
import {availableCards} from './planner.mjs';
const MINUTE=60000;
export const ACTION_BUFFER=15*MINUTE;
export function actionSlots(now,end,config) {
 if(end<=now)return [];
 return makeClock(now,Math.min(end,now+90*DAY),config).rows.filter(r=>r.weight>0).flatMap(r=>r.intervals.map(([a,b])=>[Math.max(a,now),Math.min(b,end)-ACTION_BUFFER])).filter(([a,b])=>b>=a);
}
// Advice is a live decision, not an instruction to consume the capacity plan.
export function advise({latest,windows=[],config,now,stale,validationWarning,demo=false}) {
 const w=windows.find(w=>w.bucket==='codex'&&w.duration===7*DAY);
 const base={kind:'wait',title:'暂不需要用卡',detail:'按实际任务使用，不必为了用满额度增加工作。',urgency:'quiet',lostQuota:w?.remaining??null,reviewAt:null,actionWindow:null,choices:['继续使用','稍后复核','不用这张卡']};
 const out=(kind,title,detail,extra={})=>({...base,kind,title,detail,...extra});
 if(stale||validationWarning||!w||w.remaining==null||!w.resetsAt||w.resetsAt<=now)return out('unknown','用卡建议待确认','先获取可信的新读数；旧额度、异常重置或未知窗口不会触发肯定用卡建议。');
 if(latest.ordinaryUsageAllowed===false)return out('restricted','先检查 Codex 使用状态','服务端当前限制普通额度使用，不能保证重置卡能解除限制。',{urgency:'attention'});
 const manual=config.manualCredits?.length&&(!config.manualAccount||config.manualAccount===latest.account);
 if(!manual&&(!latest.creditsKnown||latest.creditsWarning))return out('unknown','重置卡状态待确认','卡片明细未知或不完整。不会把未知当成零张，也不根据旧库存建议兑换。');
 const cards=availableCards(latest,config,now),card=cards[0];
 if(!card)return out('no-card','暂不需要用卡','没有已知到期的可用卡片；继续留意实际余量和自然重置。');
 const slots=actionSlots(now,card.expiresAt,config),last=slots.at(-1),active=slots.find(([a,b])=>a<=now&&now<=b);
 const eventKey=`${latest.account}:${card.id}:${card.expiresAt}`;
 base.card={id:card.id,expiresAt:card.expiresAt};base.eventKey=eventKey;base.actionWindow=last||null;
 const nextReset=w.resetsAt-now;
 if(!last)return out('deadline','卡片即将到期，操作时间不足','已没有符合工作时段且留有15分钟余量的兑换窗口。不要求你赶在最后一秒操作；可接受这张卡到期。',{urgency:'attention',alertKey:eventKey+':deadline'});
 const f=w.forecast;
 const evidence=!!f&&f.until-f.since>=30*MINUTE&&now-f.until<=150000&&Number.isFinite(f.perDay)&&f.perDay>0;
 const upcoming=actionSlots(now,Math.min(w.resetsAt,now+2*DAY),config)[0];
 const enough=evidence&&f.atReset>=Math.max(5,w.remaining*.1);
 if(nextReset<=30*MINUTE)return out('natural-soon','自然重置临近，先等等','很快会自然重置。现在兑换可能放弃仍可使用的余量，请先确认是否确有紧急任务。',{reviewAt:w.resetsAt});
 const needsQuota=w.remaining<=1||(evidence&&f.exhaustsAt&&upcoming&&f.exhaustsAt<Math.min(upcoming[1]+ACTION_BUFFER,w.resetsAt));
 if(needsQuota&&active)return out('consider','如需继续工作，可考虑用卡',`当前仍有 ${w.remaining.toFixed(1)}% 余量。兑换会重置额度，请先确认任务需求；完成后等待服务端核验。`,{urgency:'attention',alertKey:eventKey+':consider',reviewAt:now+15*MINUTE,actionWindow:active});
 if(now>=last[0]&&last[1]-now<=30*MINUTE)return out('expiry','这是到期前最后一段操作时间',enough?'按近期用量，现有额度可能已够用；不用这张卡也是有效选择。':'可以检查是否有值得提前完成的任务；不为了用满卡片安排额外工作。',{urgency:'attention',alertKey:eventKey+':expiry',reviewAt:last[1]});
 const review={reviewAt:Math.min(last[1],now+30*MINUTE)};
 if(demo)return out('demo','演示模式：额度保持不变','演示额度固定，不会随真实使用或等待时间变化。查看真实用量和建议，请关闭演示模式并正常启动。',review);
 if(evidence)return out('wait','目前先保留重置卡','近期样本仅供参考。临近额度不足或卡片到期时再复核，不必遵循固定兑换时刻。',review);
 if(!f)return out('learning','正在等待连续用量记录','刚启动、采样中断超过15分钟、额度重置，或记录未覆盖工作时段时，暂不能形成趋势。请保持程序运行并按需使用；形成趋势后会显示30分钟观察进度。',review);
 if(now-f.until>150000)return out('learning','用量趋势等待更新','最近的趋势读数已过期，请刷新用量。已有记录会保留，但长时间采样中断后需要重新观察。',review);
 if(!Number.isFinite(f.perDay)||f.perDay<0||!Number.isFinite(f.since)||!Number.isFinite(f.until)||f.until<f.since)return out('learning','用量趋势待确认','目前无法从记录中确认有效消耗速度。请等待新的可信读数，再估算用卡时机。',review);
 const minutes=Math.floor((f.until-f.since)/MINUTE);
 if(f.perDay===0)return out('no-consumption','近期额度没有下降',`最近${minutes}分钟的账户余量没有可测变化，暂不估算耗尽时间。按实际任务使用即可，无需为了积累样本增加消耗。`,review);
 return out('learning',`正在观察用量（${minutes}/30 分钟）`,`已观察到额度消耗，还需约${30-minutes}分钟连续读数。请保持程序运行；采样中断超过15分钟或额度重置后会重新计时。`,review);
}
export function reminder(advice,preferences,now) {
 const key=advice.alertKey;
 if(!preferences.enabled||!key||advice.urgency!=='attention'||preferences.dismissed===key||(preferences.snoozeId===key&&preferences.snoozeUntil>now)||preferences.delivered===key)return null;
 return {id:key,title:advice.title,body:advice.detail};
}
