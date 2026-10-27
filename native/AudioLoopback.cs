// Windows WASAPI process-loopback capture. Excludes the app browser process tree.
// API reference: learn.microsoft.com/windows/win32/api/audioclientactivationparams/
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, uint flags, long bufferDuration, long periodicity, ref WaveFormat format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, ref WaveFormat format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid id, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}
[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong timestamp);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceAsyncOperation {
    [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object client);
}
[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceCompletionHandler {
    [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}
[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject { }
[StructLayout(LayoutKind.Sequential, Pack = 2)]
struct WaveFormat {
    public ushort Tag, Channels;
    public uint SampleRate, AverageBytes;
    public ushort BlockAlign, Bits, Extra;
}
[StructLayout(LayoutKind.Sequential)]
struct ActivationParams { public uint ActivationType, ProcessId, LoopbackMode; }
[StructLayout(LayoutKind.Explicit, Size = 24)]
struct PropVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public uint Size;
    [FieldOffset(16)] public IntPtr Data;
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject {
    public readonly ManualResetEvent Completed = new ManualResetEvent(false);
    public object Client;
    public Exception Error;
    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) {
        try {
            int result;
            Marshal.ThrowExceptionForHR(operation.GetActivateResult(out result, out Client));
            Marshal.ThrowExceptionForHR(result);
        } catch (Exception error) { Error = error; }
        finally { Completed.Set(); }
        return 0;
    }
}
static class AudioLoopback {
    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    static extern int ActivateAudioInterfaceAsync(string device, ref Guid iid, ref PropVariant parameters, IActivateAudioInterfaceCompletionHandler callback, out IActivateAudioInterfaceAsyncOperation operation);
    static volatile bool stopping;
    static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }
    [MTAThread]
    static int Main(string[] args) {
        IAudioClient client = null; IAudioCaptureClient capture = null; IntPtr activation = IntPtr.Zero;
        bool started = false;
        string stage = "activate";
        try {
            if (args.Length < 2 || args[0] != "--exclude") throw new ArgumentException("Usage: AudioLoopback --exclude <app-browser-pid> [--probe]");
            uint target = uint.Parse(args[1]);
            if (target == 0) throw new ArgumentException("A real app process ID is required.");
            Process.GetProcessById(checked((int)target));
            ActivationParams parameters = new ActivationParams { ActivationType = 1, ProcessId = target, LoopbackMode = 1 };
            activation = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ActivationParams)));
            Marshal.StructureToPtr(parameters, activation, false);
            PropVariant variant = new PropVariant { Type = 65, Size = (uint)Marshal.SizeOf(typeof(ActivationParams)), Data = activation };
            Guid clientId = typeof(IAudioClient).GUID;
            var handler = new ActivationHandler(); IActivateAudioInterfaceAsyncOperation operation;
            Check(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref clientId, ref variant, handler, out operation));
            stage = "activation-result";
            if (!handler.Completed.WaitOne(10000)) throw new TimeoutException("Windows audio activation timed out.");
            if (handler.Error != null) throw handler.Error;
            client = (IAudioClient)handler.Client;
            stage = "initialize";
            WaveFormat format = new WaveFormat { Tag = 1, Channels = 2, SampleRate = 48000, AverageBytes = 192000, BlockAlign = 4, Bits = 16, Extra = 0 };
            // Shared, loopback, event callback, automatic PCM conversion.
            Check(client.Initialize(0, 0x80060000, 0, 0, ref format, IntPtr.Zero));
            stage = "service";
            object service; Guid captureId = typeof(IAudioCaptureClient).GUID;
            Check(client.GetService(ref captureId, out service)); capture = (IAudioCaptureClient)service;
            using (var samplesReady = new AutoResetEvent(false)) {
                stage = "event";
                Check(client.SetEventHandle(samplesReady.SafeWaitHandle.DangerousGetHandle()));
                if (Array.IndexOf(args, "--probe") >= 0) { Console.WriteLine("{\"ready\":true,\"excludedPid\":" + target + ",\"sampleRate\":48000,\"channels\":2,\"format\":\"s16le\"}"); return 0; }
                // Parent closes stdin on tab/session shutdown; no orphaned recording process.
                var watcher = new Thread(delegate() { try { var input = Console.OpenStandardInput(); while (input.ReadByte() >= 0) { } } catch { } stopping = true; });
                watcher.IsBackground = true; watcher.Start();
                using (Stream output = Console.OpenStandardOutput()) {
                    byte[] header = System.Text.Encoding.ASCII.GetBytes("{\"ready\":true,\"excludedPid\":" + target + ",\"sampleRate\":48000,\"channels\":2,\"format\":\"s16le\"}\n");
                    output.Write(header, 0, header.Length); output.Flush();
                    Check(client.Start()); started = true;
                    byte[] buffer = new byte[192000];
                    while (!stopping) {
                        samplesReady.WaitOne(200);
                        uint available;
                        Check(capture.GetNextPacketSize(out available));
                        while (available > 0 && !stopping) {
                            IntPtr data; uint frames, flags; ulong position, timestamp;
                            Check(capture.GetBuffer(out data, out frames, out flags, out position, out timestamp));
                            try {
                                int bytes = checked((int)frames * 4);
                                if (buffer.Length < bytes) buffer = new byte[bytes];
                                if ((flags & 2) != 0) Array.Clear(buffer, 0, bytes); else Marshal.Copy(data, buffer, 0, bytes);
                                output.Write(buffer, 0, bytes); output.Flush();
                            } finally { Check(capture.ReleaseBuffer(frames)); }
                            Check(capture.GetNextPacketSize(out available));
                        }
                    }
                }
            }
            GC.KeepAlive(handler); GC.KeepAlive(operation);
            return 0;
        } catch (IOException) { return 0; }
        catch (Exception error) { Console.Error.WriteLine("Loopback unavailable (" + stage + "): " + error.Message + " (0x" + error.HResult.ToString("X8") + ")"); return 1; }
        finally {
            if (started && client != null) client.Stop();
            if (capture != null) Marshal.ReleaseComObject(capture);
            if (client != null) Marshal.ReleaseComObject(client);
            if (activation != IntPtr.Zero) Marshal.FreeHGlobal(activation);
        }
    }
}
