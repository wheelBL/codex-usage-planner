using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 [STAThread] static void Main(string[] args) {
  try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}
  bool demo=args.Contains("--demo"), smoke=args.Contains("--smoke");
  bool created; using(var mutex=new Mutex(true,"Local\\CodexUsagePlanner-V2-"+(demo?43128:43127),out created)) {
   if(!created){try{using(var signal=EventWaitHandle.OpenExisting("Local\\CodexUsagePlanner-Show-"+(demo?43128:43127)))signal.Set();}catch{}return;}
   Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
   try { using(var app=new TrayApp(demo,smoke)) Application.Run(app); }
   catch(Exception e){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"startup-error.log"),e.ToString());if(!smoke)MessageBox.Show(e.Message,"Codex 用量节奏");Environment.ExitCode=1;}
  }
 }
}
internal sealed class TrayApp : ApplicationContext {
 [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
 [DllImport("user32.dll")] static extern bool ReleaseCapture();
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,int msg,int w,int l);
 [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h,int attribute,ref int value,int size);
 readonly string root,url; readonly bool smoke; readonly NotifyIcon tray; readonly Form panel; readonly WebView2 web;
 readonly System.Windows.Forms.Timer statusWatch=new System.Windows.Forms.Timer(); DateTime lastStatus=DateTime.UtcNow;
 EventWaitHandle showSignal; RegisteredWaitHandle signalWait; Process service; bool pinned,closing,ready; Icon currentIcon; readonly Button pin; readonly JavaScriptSerializer json=new JavaScriptSerializer();
 public TrayApp(bool demo,bool smoke) {
  this.smoke=smoke;root=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..",".."));url="http://127.0.0.1:"+(demo?43128:43127);
  panel=new Form {Text="Codex 用量节奏",FormBorderStyle=FormBorderStyle.None,ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,BackColor=Color.FromArgb(16,20,23),TopMost=true,Width=820,Height=880};
  var bar=new Panel {Dock=DockStyle.Top,Height=40,BackColor=Color.FromArgb(21,28,31)};
  var title=new Label {Text="◉   CODEX  /  用量节奏",ForeColor=Color.FromArgb(159,232,200),Dock=DockStyle.Fill,Padding=new Padding(16,10,0,0),Font=new Font("Segoe UI",10)};
  title.MouseDown+=(s,e)=>{if(e.Button==MouseButtons.Left){ReleaseCapture();SendMessage(panel.Handle,0xA1,2,0);}};
  var close=HeaderButton("×");close.Click+=(s,e)=>panel.Hide();pin=HeaderButton("固定");pin.Click+=(s,e)=>{pinned=!pinned;pin.Text=pinned?"已固定":"固定";};bar.Controls.Add(title);bar.Controls.Add(pin);bar.Controls.Add(close);
  web=new WebView2 {Dock=DockStyle.Fill,DefaultBackgroundColor=Color.FromArgb(16,20,23)};panel.Controls.Add(web);panel.Controls.Add(bar);
  panel.Deactivate+=(s,e)=>{if(!pinned&&ready&&!smoke)panel.Hide();};panel.FormClosing+=(s,e)=>{if(!closing){e.Cancel=true;panel.Hide();}};
  tray=new NotifyIcon {Text="Codex · 正在读取用量",Visible=true};UpdateIcon(null,null,true);statusWatch.Interval=15000;statusWatch.Tick+=(s,e)=>{if((DateTime.UtcNow-lastStatus).TotalSeconds>150){UpdateIcon(null,null,true);tray.Text="Codex · 状态读取中断 / 数据已过期";}};statusWatch.Start();
  tray.MouseClick+=(s,e)=>{if(e.Button==MouseButtons.Left){if(panel.Visible)panel.Hide();else ShowPanel();}};
  var menu=new ContextMenuStrip();menu.Items.Add("打开用量面板",null,(s,e)=>ShowPanel());menu.Items.Add("退出",null,(s,e)=>ExitThread());tray.ContextMenuStrip=menu;
  panel.Shown+=async(s,e)=>{if(!ready)await Initialize(demo);};ShowPanel();
  showSignal=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\CodexUsagePlanner-Show-"+(demo?43128:43127));signalWait=ThreadPool.RegisterWaitForSingleObject(showSignal,(s,t)=>{if(!closing)try{panel.BeginInvoke((Action)ShowPanel);}catch{}},null,-1,false);
 }
 Button HeaderButton(string text){return new Button {Text=text,Dock=DockStyle.Right,Width=58,FlatStyle=FlatStyle.Flat,FlatAppearance={BorderSize=0},ForeColor=Color.FromArgb(169,188,181),BackColor=Color.FromArgb(21,28,31),TabStop=true};}
 void ShowPanel(){var point=Cursor.Position;var area=Screen.FromPoint(point).WorkingArea;panel.Size=new Size(Math.Min(820,area.Width-24),Math.Min(880,area.Height-24));panel.Location=new Point(Math.Max(area.Left+12,Math.Min(point.X-panel.Width+28,area.Right-panel.Width-12)),point.Y<area.Top+60?area.Top+12:area.Bottom-panel.Height-12);panel.Show();panel.Activate();int corner=2;try{DwmSetWindowAttribute(panel.Handle,33,ref corner,4);}catch{}}
 async Task Initialize(bool demo){
  try {
   string node=Environment.GetEnvironmentVariable("PLANNER_NODE");if(String.IsNullOrEmpty(node))node=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"nodejs","node.exe");
   if(!File.Exists(node))throw new Exception("未找到 Node.js。请安装 Node.js 20+，或设置 PLANNER_NODE。");
   var start=new ProcessStartInfo(node,"\""+Path.Combine(root,"server.mjs")+"\""+(demo?" --demo":"")){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root};
   start.EnvironmentVariables["PLANNER_PARENT_PID"]=Process.GetCurrentProcess().Id.ToString();
   string codex=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"OpenAI","Codex","bin","codex.exe");if(File.Exists(codex)&&String.IsNullOrEmpty(start.EnvironmentVariables["CODEX_COMMAND"]))start.EnvironmentVariables["CODEX_COMMAND"]=json.Serialize(new[]{codex});
   service=Process.Start(start);
   using(var client=new HttpClient(new HttpClientHandler {UseProxy=false}){Timeout=TimeSpan.FromSeconds(1)}){bool connected=false;for(int i=0;i<60;i++){if(service.HasExited)throw new Exception("服务未启动，端口可能被旧版占用。请先从旧托盘退出。");try{var r=await client.GetAsync(url);if(r.IsSuccessStatusCode){connected=true;break;}}catch{}await Task.Delay(100);}if(!connected)throw new Exception("本机用量服务启动超时。");}
   var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(root,"data",demo?"webview-demo":"webview"));await web.EnsureCoreWebView2Async(environment);
   web.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;web.CoreWebView2.Settings.IsStatusBarEnabled=false;
   web.CoreWebView2.NewWindowRequested+=(s,e)=>{e.Handled=true;};
   web.CoreWebView2.NavigationStarting+=(s,e)=>{if(!e.Uri.StartsWith(url+"/",StringComparison.Ordinal))e.Cancel=true;};
   web.CoreWebView2.WebMessageReceived+=(s,e)=>{if(!e.Source.StartsWith(url+"/",StringComparison.Ordinal))return;try{var m=json.DeserializeObject(e.WebMessageAsJson) as System.Collections.Generic.Dictionary<string,object>;if(m==null)return;lastStatus=DateTime.UtcNow;bool stale=!m.ContainsKey("stale")||Convert.ToBoolean(m["stale"]);double? remaining=m.ContainsKey("remaining")&&m["remaining"]!=null?(double?)Convert.ToDouble(m["remaining"]):null;double? gap=m.ContainsKey("gap")&&m["gap"]!=null?(double?)Convert.ToDouble(m["gap"]):null;double? rate=m.ContainsKey("plannedPerWorkday")&&m["plannedPerWorkday"]!=null?(double?)Convert.ToDouble(m["plannedPerWorkday"]):null;UpdateIcon(remaining,gap,stale,rate);string tip=stale?"Codex · "+(m.ContainsKey("error")?Convert.ToString(m["error"]):"状态读取失败"):"Codex · 外环实际 "+remaining.GetValueOrDefault().ToString("F1")+"% / 差额 "+(gap.HasValue?gap.Value.ToString("+0.0;-0.0;0.0")+"点":"未知")+(rate.HasValue&&rate.Value>0?" / "+(gap.GetValueOrDefault()<0?"偏快 ":"偏慢 ")+Math.Abs(gap.GetValueOrDefault()/rate.Value).ToString("F2")+"工作日":" / 节奏未知");tray.Text=tip.Length>63?tip.Substring(0,63):tip;}catch{UpdateIcon(null,null,true);tray.Text="Codex · 状态消息异常";}};
   web.CoreWebView2.NavigationCompleted+=async(s,e)=>{ready=true;if(smoke){if(PaceFill(0,20)!=50||PaceFill(-5,20)!=75||PaceFill(5,20)!=25||PaceFill(-10,20)!=100||PaceFill(10,20)!=0||PaceFill(2,0)!=null)throw new Exception("Pace ring boundaries failed");await Task.Delay(900);await web.CoreWebView2.ExecuteScriptAsync("window.chrome.webview.postMessage({remaining:56,gap:5,plannedPerWorkday:20,stale:false})");await Task.Delay(100);if(!tray.Text.Contains("+5.0"))throw new Exception("Positive gap failed");using(var sample=currentIcon.ToBitmap())sample.Save(Path.Combine(root,"native","icon-ahead.png"));await web.CoreWebView2.ExecuteScriptAsync("window.chrome.webview.postMessage({remaining:56,gap:-5,plannedPerWorkday:20,stale:false})");await Task.Delay(100);if(!tray.Text.Contains("-5.0"))throw new Exception("Negative gap failed");using(var sample=currentIcon.ToBitmap())sample.Save(Path.Combine(root,"native","icon-behind.png"));using(var sample=currentIcon.ToBitmap())sample.Save(Path.Combine(root,"native","icon-active.png"));await web.CoreWebView2.ExecuteScriptAsync("window.chrome.webview.postMessage({stale:true,error:'RPC -32603'})");await Task.Delay(150);if(!tray.Text.Contains("RPC -32603"))throw new Exception("Tray error propagation failed");using(var sample=currentIcon.ToBitmap())sample.Save(Path.Combine(root,"native","icon-error.png"));string result=await web.CoreWebView2.ExecuteScriptAsync("({title:document.title,embedded:document.body.classList.contains('embedded'),tabs:document.querySelectorAll('[data-tab]').length,dailyRows:document.querySelectorAll('#daily-rows tr').length})");File.WriteAllText(Path.Combine(root,"native","smoke-result.json"),result);using(var output=File.Create(Path.Combine(root,"native","tray-preview.png")))await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,output);await web.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-tab=plan]').click()");await Task.Delay(150);using(var output=File.Create(Path.Combine(root,"native","plan-preview.png")))await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,output);ExitThread();}};
   web.CoreWebView2.Navigate(url+"/?embedded=1");
  }catch(Exception e){File.WriteAllText(Path.Combine(root,"native","startup-error.log"),e.ToString());Environment.ExitCode=1;if(!smoke)MessageBox.Show(e.Message,"Codex 用量节奏");ExitThread();}
 }
 static double? PaceFill(double? gap,double? rate){if(!gap.HasValue||!rate.HasValue||rate.Value<=0||Double.IsNaN(gap.Value)||Double.IsNaN(rate.Value)||Double.IsInfinity(gap.Value)||Double.IsInfinity(rate.Value))return null;return Math.Max(0,Math.Min(100,50-100*gap.Value/rate.Value));}
 void UpdateIcon(double? remaining,double? gap,bool stale,double? rate=null){using(var bitmap=new Bitmap(32,32)){using(var g=Graphics.FromImage(bitmap)){g.SmoothingMode=SmoothingMode.AntiAlias;g.Clear(Color.Transparent);
  using(var bg=new SolidBrush(Color.FromArgb(230,12,16,22)))g.FillEllipse(bg,0,0,32,32);
  float[] boxes={3,10};double?[] values={remaining,PaceFill(gap,rate)};Color[] colors={Color.FromArgb(0,245,170),gap.GetValueOrDefault()<0?Color.FromArgb(255,45,135):Color.FromArgb(0,210,255)};
  for(int i=0;i<2;i++){float b=boxes[i],size=32-2*b;using(var track=new Pen(stale?Color.FromArgb(130,135,145):Color.FromArgb(65,70,82),4))g.DrawEllipse(track,b,b,size,size);if(!stale&&values[i].HasValue){using(var fill=new Pen(colors[i],4)){fill.StartCap=LineCap.Round;fill.EndCap=LineCap.Round;g.DrawArc(fill,b,b,size,size,-90,(float)(3.6*Math.Max(0,Math.Min(100,values[i].Value))));}}}
  if(stale){using(var mark=new Pen(Color.White,2)){g.DrawLine(mark,16,11,16,17);g.DrawLine(mark,16,20,16,21);}}
 }var h=bitmap.GetHicon();var replacement=(Icon)Icon.FromHandle(h).Clone();DestroyIcon(h);tray.Icon=replacement;if(currentIcon!=null)currentIcon.Dispose();currentIcon=replacement;}}

 protected override void ExitThreadCore(){if(closing)return;closing=true;statusWatch.Stop();statusWatch.Dispose();if(signalWait!=null)signalWait.Unregister(null);if(showSignal!=null)showSignal.Dispose();tray.Visible=false;tray.Dispose();web.Dispose();panel.Dispose();if(currentIcon!=null)currentIcon.Dispose();try{if(service!=null&&!service.HasExited){var kill=Process.Start(new ProcessStartInfo("taskkill.exe","/PID "+service.Id+" /T /F"){UseShellExecute=false,CreateNoWindow=true});kill.WaitForExit(5000);}}catch{}if(service!=null)service.Dispose();base.ExitThreadCore();}
}
