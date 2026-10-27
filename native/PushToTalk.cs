// Polls only the explicitly configured PTT key and its modifiers. Never reads or logs typed text.
using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;
static class PushToTalk {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  static volatile bool stopping;
  static bool Down(int key) { return key == 91 ? (GetAsyncKeyState(91) < 0 || GetAsyncKeyState(92) < 0) : GetAsyncKeyState(key) < 0; }
  static int Main(string[] args) {
    try {
      if(args.Length != 2) return 2;
      var owner=Process.GetProcessById(int.Parse(args[0])); var parts=args[1].Split(',');
      if(parts.Length<1 || parts.Length>5) return 2;
      var keys=Array.ConvertAll(parts,int.Parse); foreach(int key in keys) if(key<1 || key>255) return 2;
      var input=new Thread(()=>{try{while(Console.ReadLine()!=null){} }catch{} finally{stopping=true;}});input.IsBackground=true;input.Start();
      bool previous=false,blocked=true;long sent=0;var clock=Stopwatch.StartNew();
      Console.WriteLine("{\"down\":false}");Console.Out.Flush();
      while(!stopping && !owner.HasExited){
        bool down=true; foreach(int key in keys) down &= Down(key);
        if(!down) blocked=false;
        down &= !blocked;
        if(down!=previous || clock.ElapsedMilliseconds-sent>=250){Console.WriteLine(down?"{\"down\":true}":"{\"down\":false}");Console.Out.Flush();previous=down;sent=clock.ElapsedMilliseconds;}
        Thread.Sleep(8);
      }
      Console.WriteLine("{\"down\":false}");Console.Out.Flush();return 0;
    }catch{return 1;}
  }
}
