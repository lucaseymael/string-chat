using System;using System.IO;using System.Media;
class TestTone {
 static void Main(){const int rate=48000,frames=rate;using(var memory=new MemoryStream()){var w=new BinaryWriter(memory);w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));w.Write(36+frames*2);w.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));w.Write(16);w.Write((short)1);w.Write((short)1);w.Write(rate);w.Write(rate*2);w.Write((short)2);w.Write((short)16);w.Write(System.Text.Encoding.ASCII.GetBytes("data"));w.Write(frames*2);for(int i=0;i<frames;i++)w.Write((short)(400*Math.Sin(2*Math.PI*880*i/rate)));memory.Position=0;using(var player=new SoundPlayer(memory)){player.PlayLooping();try{Console.ReadLine();}finally{player.Stop();}}}}
}
