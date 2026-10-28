using System;using System.IO;using System.Diagnostics;using System.Windows.Forms;using System.Threading;
[assembly:System.Reflection.AssemblyTitle("String Chat")][assembly:System.Reflection.AssemblyProduct("String Chat")][assembly:System.Reflection.AssemblyVersion("1.8.0.0")]
class Maintenance{
 static string Quote(string value){return "\""+value.Replace("\"","")+"\"";}
 [STAThread]static void Main(string[] args){try{
  string root=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
  if(args.Length>=3&&args[0]=="--remove-root"){
   root=InstallSupport.Full(args[1]);if(!File.Exists(Path.Combine(root,"current.json")))throw new IOException("Instalação não identificada.");int parent;if(int.TryParse(args[2],out parent))try{Process.GetProcessById(parent).WaitForExit(10000);}catch{}
   InstallSupport.Current(root);InstallSupport.StopApps(root);InstallSupport.RemoveIntegrations(root);InstallSupport.NoLinks(root);
   string expected=InstallSupport.DefaultRoot;if(!string.Equals(root,expected,StringComparison.OrdinalIgnoreCase))throw new IOException("Pasta de desinstalação inválida.");Directory.Delete(root,true);MessageBox.Show("String Chat removido. Seu perfil e suas conversas foram preservados.","String Chat");return;
  }
  if(args.Length>0&&args[0]=="--uninstall"){
   if(MessageBox.Show("Remover o String Chat deste computador?\n\nSeu perfil, amigos e conversas serão preservados.","Desinstalar String Chat",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
   InstallSupport.Current(root);string helper=Path.Combine(Path.GetTempPath(),"StringChat-Uninstall-"+Guid.NewGuid().ToString("N")+".exe");File.Copy(System.Reflection.Assembly.GetExecutingAssembly().Location,helper);Process.Start(new ProcessStartInfo(helper,"--remove-root "+Quote(root)+" "+Process.GetCurrentProcess().Id){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Hidden});return;
  }
  string target=InstallSupport.Current(root);if(args.Length==1&&args[0]=="--verify-install"){InstallSupport.VerifyExecutable(target);return;}string arguments=string.Join(" ",Array.ConvertAll(args,Quote));Process.Start(new ProcessStartInfo(Path.Combine(target,"StringChat.exe"),arguments){WorkingDirectory=target,UseShellExecute=true});
 }catch(Exception error){MessageBox.Show(error.Message+"\n\nExecute novamente o instalador do String Chat para reparar.","String Chat",MessageBoxButtons.OK,MessageBoxIcon.Warning);Environment.ExitCode=1;}}
}
