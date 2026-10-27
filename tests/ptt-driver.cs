// QA only: sends the test's dedicated F23 key; always releases on EOF.
using System;
using System.Runtime.InteropServices;
class TestKey {
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  static void Main() { try { string line; while((line=Console.ReadLine())!=null) { if(line=="down") keybd_event(134,0,0,UIntPtr.Zero); else keybd_event(134,0,2,UIntPtr.Zero); } } finally { keybd_event(134,0,2,UIntPtr.Zero); } }
}
