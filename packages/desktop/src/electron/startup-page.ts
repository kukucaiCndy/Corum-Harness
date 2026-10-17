import type { StartupThemeInfo } from './startup-themes.ts'

export interface StartupPageOptions { theme: StartupThemeInfo; animationEnabled: boolean; preview: boolean; platform: string }

/** 零 host 依赖的播放器，主题本身没有桌面 bridge。 */
export function renderStartupPageHtml({ theme, animationEnabled, preview, platform }: StartupPageOptions): string {
  const config = JSON.stringify({ theme, animationEnabled, preview }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Corum · 正在启动</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}
body{background:${theme.background ?? '#0A0612'}}
main{position:absolute;inset:0;display:grid;place-items:center}iframe,video{position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;object-fit:contain}
#waiting{padding:28px;text-align:center;line-height:1.8;color:#B98CFF;font:14px Inter,-apple-system,'PingFang SC',sans-serif}#status{white-space:pre-wrap;overflow-wrap:anywhere}
[hidden]{display:none!important}@media(prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head><body>
<main id="stage"><div id="waiting" role="status"><h1>Corum Harness</h1><p id="status">正在初始化后台服务…</p><button id="retry" hidden>重试启动</button></div></main>
<script>
const config=${config};
const bridge=window.corumDesktop;
const stage=document.getElementById('stage'),status=document.getElementById('status'),retry=document.getElementById('retry');
let frame=null,video=null,holding=false,finished=false,failed=false,watchdog,startupGuard;
// 分段视频：segments 存在时按启动阶段切换播放；否则回退单个 entry。
const segs=config.theme.segments;
const segMap={};if(segs)for(const s of segs)segMap[s.stage]={stage:s.stage,file:s.file};
const SEG_ORDER=['env','plugins','mounting','ready'];
/** 只有 ready 段是一次性收尾；其余段在阶段内无缝循环（见下方 playSegment）。 */
const isLoopStage=(st)=>st!=='ready';
function segSrc(st){return 'corumapp://startup-theme/'+config.theme.id+'/'+segMap[st].file.split('/').map(encodeURIComponent).join('/');}
let curStage=null;
// 换段代数：每次 playSegment 成功换 src 就 +1。media 事件挂在 video 元素上，
// 换 src 后旧段的迟到事件仍会触发，回调据此判断「这是不是我这一代的事件」。
//
// 2026-10-17 实测的报障就出在这：启动时 publishStage('env') 与 ('spawn') 几乎
// 同一 tick 到达，playSegment 连续换两次 src，env 的 play() promise 以
// **AbortError** 拒绝，而旧代码 video.play().catch(mediaError) 把它当成致命错误
// → 直接报「主题无法播放」并跳过整段动画。
let segEpoch=0;
const singleSrc=config.theme.entry?('corumapp://startup-theme/'+config.theme.id+'/'+config.theme.entry.split('/').map(encodeURIComponent).join('/')):'';
function releaseMedia(){clearTimeout(watchdog);clearTimeout(startupGuard);frame?.remove();frame=null;if(video){video.pause();video.removeAttribute('src');video.load();video.remove();video=null;}}
function stopAnimation(){if(finished||failed)return;finished=true;clearTimeout(watchdog);clearTimeout(startupGuard);if(config.preview){bridge.closeStartupPreview?.();return;}releaseMedia();bridge.finishStartup();}
function mediaError(){if(finished||failed)return;releaseMedia();if(config.preview){finished=true;status.textContent='主题无法播放，请检查入口文件或视频编码。';return;}status.textContent='主题无法播放，正在继续启动…';stopAnimation();}
// AbortError 表示「这次 play 被新的加载打断了」——换段时必然发生，不是故障。
// 只有 NotSupportedError / NotAllowedError 这类才说明主题真的播不了。
// 判据来自 2026-10-17 在 Electron 43 里的实测：换 src 时旧 play() 必抛 AbortError。
function isBenignPlayRejection(error){return error!==null&&typeof error==='object'&&error.name==='AbortError';}
// 统一的播放启动：忽略可忽略的打断，其余才上报。
function startPlayback(muted){
 if(!video)return;
 video.muted=muted;
 video.play().catch((error)=>{if(isBenignPlayRejection(error))return;mediaError();});
}
// 分段播放器：复用 video 元素，只换 src。
//
// 关键：加载阶段（env/spawn/plugins/mounting）在阶段内**循环播放**。启动各阶段耗时不可预知
// （冷启动的 plugins 可能远比热启动长），所以每段做成可无缝循环的短片，由主进程的阶段回调
// 驱动切换；只有 ready 段播完即收尾。
//
// 由此看门狗必须分两层，否则正常播放也会被误判成失败：
//   - watchdog（每段）：这一段「加载并播起来」的超时；循环段一旦在播就清掉——循环段永远
//     不会 ended，若沿用 duration+10s 的超时，播到第 duration+10 秒就会被误判失败。
//   - startupGuard（一次性）：从开始到「第一段真的播起来」的兜底，用于「媒体全挂但没触发
//     error」的情况。第一段播起来后它就没有意义了——后续阶段推进是主进程的职责，而主进程
//     自己另有启动超时。
// 事件回调要带上「这一代」的标记：换 src 后旧段的 loadedmetadata/playing 仍会
// 触发，若不校验就会用**新段**的 duration/loop 去清**新段**的 watchdog，导致
// 新段卡住时永远没有兜底。见 segEpoch 的注释。
function onSegMeta(evtEpoch){
 if(evtEpoch!==segEpoch)return; // 陈旧事件：属于上一段，丢弃
 if(!video||!Number.isFinite(video.duration)||video.duration<=0){
  // 换 src 瞬间 duration 是 NaN；给一个短暂宽限再判定，避免把「还没解析完」当故障。
  setTimeout(()=>{if(finished||failed||evtEpoch!==segEpoch)return;
   if(!video||!Number.isFinite(video.duration)||video.duration<=0)mediaError();},600);
  return;
 }
 clearTimeout(watchdog);
 // 循环段没有终点，播起来就算成功；ready 段必须自己播完。
 if(!video.loop)watchdog=setTimeout(mediaError,(video.duration+10)*1000);
}
function onSegPlaying(evtEpoch){
 if(evtEpoch!==segEpoch)return; // 陈旧事件：不能替新段清兜底
 clearTimeout(startupGuard);
 if(video&&video.loop)clearTimeout(watchdog);
}
function onSegEnded(){if(finished||failed)return;if(curStage==='ready'){stopAnimation();return;}if(config.preview){for(let i=SEG_ORDER.indexOf(curStage)+1;i<SEG_ORDER.length;i++){if(segMap[SEG_ORDER[i]]){playSegment(SEG_ORDER[i]);return;}}stopAnimation();}}
function playSegment(st){
 if(!segs||finished||failed)return;
 const seg=segMap[st];if(!seg||curStage===st)return;
 curStage=st;
 if(!video){
  video=document.createElement('video');
  video.playsInline=true;video.preload='auto';
  video.addEventListener('error',mediaError);
  video.addEventListener('ended',onSegEnded);
  stage.append(video);
 }
 // 换段 = 新的一代。先递增再绑监听器，这样下面绑的回调只认这一代的事件。
 const epoch=++segEpoch;
 // 每次换段都重绑：闭包捕获 epoch，旧段的迟到事件因 epoch 不符被丢弃。
 video.onloadedmetadata=()=>onSegMeta(epoch);
 video.onplaying=()=>onSegPlaying(epoch);
 // 预览时按顺序放完所有段，所以不循环；正式启动时加载段循环。
 video.loop=isLoopStage(st)&&!config.preview;
 const wantAudio=!isLoopStage(st)&&!config.preview;
 clearTimeout(watchdog);
 video.src=segSrc(st);
 watchdog=setTimeout(mediaError,15000);
 if(wantAudio){
  // ready 段的琶音。Electron 默认 autoplayPolicy 为 no-user-gesture-required，
  // 所以这里能直接出声；若环境拒绝，退回静音再播，绝不因为音频把启动卡住。
  video.muted=false; // 必须显式解除：上一段（加载段）是静音的，元素是复用的
  video.play().catch((error)=>{
   if(isBenignPlayRejection(error))return;
   video.muted=true;
   video.play().catch((retry)=>{if(!isBenignPlayRejection(retry))mediaError();});
  });
 }else{
  startPlayback(true);
 }
}function showStatus(state){
 if(!state)return;
 if(state.phase==='error'){failed=true;releaseMedia();status.textContent='启动失败：'+state.message;retry.hidden=false;return;}
 if(segs){if(state.phase==='ready'){status.textContent='主界面已就绪，等待动画结束…';playSegment('ready');return;}if(state.stage){playSegment(state.stage);return;}}
 else if(state.phase==='ready')status.textContent='主界面已就绪，等待动画结束…';
}
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!failed)stopAnimation();});
stage.addEventListener('click',()=>{if(holding&&!failed&&!config.preview)stopAnimation();});
retry.addEventListener('click',()=>{retry.disabled=true;bridge.retryStartup();});
window.addEventListener('message',event=>{
 if(!frame||event.source!==frame.contentWindow||failed)return;
 if(event.data==='corum:startup-holding'||(config.theme.builtin&&event.data==='embedlink:startup-holding'))holding=true;
 else if(event.data==='corum:startup-complete'||(config.theme.builtin&&event.data==='embedlink:startup-complete'))stopAnimation();
});
if(!config.preview){bridge.onStartupStatus(showStatus);bridge.getStartupStatus().then(showStatus);}
if((config.animationEnabled&&!matchMedia('(prefers-reduced-motion: reduce)').matches)||config.preview){
 if(config.theme.type==='video'){
  if(segs){
   // 分段模式：预览时自动从头播到最后一段；正式启动时等阶段回调。
   //
   // 这个 guard 只在「第一段都没能播起来」时兜底；一旦有段开始播放（onSegPlaying）
   // 就清掉，之后阶段推进完全交给主进程的回调——否则冷启动偏慢时会被误判为失败。
   if(config.preview)playSegment(SEG_ORDER.find(s=>segMap[s])||'ready');
   else startupGuard=setTimeout(()=>{if(!finished&&!failed)mediaError();},60000);
  }else{
   video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';video.src=singleSrc;
   video.addEventListener('loadedmetadata',()=>{if(!video||!Number.isFinite(video.duration)||video.duration<=0){mediaError();return;}clearTimeout(watchdog);watchdog=setTimeout(mediaError,(video.duration+10)*1000);});
   video.addEventListener('ended',stopAnimation);video.addEventListener('error',mediaError);stage.append(video);watchdog=setTimeout(mediaError,10000);
   // 与分段路径同款：AbortError 只是被打断，不是播不了。
   video.play().catch((error)=>{if(!isBenignPlayRejection(error))mediaError();});
  }
 }else{
  frame=document.createElement('iframe');frame.title='启动主题动画';frame.setAttribute('sandbox','allow-scripts');frame.tabIndex=-1;frame.setAttribute('aria-hidden','true');frame.src=singleSrc;frame.addEventListener('error',mediaError);stage.append(frame);watchdog=setTimeout(mediaError,45000);
 }
 }else{stopAnimation();}
window.addEventListener('pagehide',releaseMedia);
</script></body></html>`
}
