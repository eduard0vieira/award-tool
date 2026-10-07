# Ignores the notebook's own keyboard and touchpad while it runs, so keys the
# closed lid presses never reach the bot's Chrome. Remote input (Chrome Remote
# Desktop) arrives flagged as injected and keeps working. See docs/SETUP-SERVER.md.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File C:\bot\award-tool\scripts\block-local-input.ps1
#   powershell -ExecutionPolicy Bypass -File C:\bot\award-tool\scripts\block-local-input.ps1 -TestMinutes 2
#
# Stop it by closing this window (from the remote session). Ctrl+Alt+Del on the
# notebook itself is never blocked, so the keyboard can always get back in.

param([int]$TestMinutes = 0)

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class PhysicalInputBlocker {
    const int WH_KEYBOARD_LL = 13;
    const int WH_MOUSE_LL = 14;
    const uint LLKHF_INJECTED = 0x10;
    const uint LLMHF_INJECTED = 0x01;

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public int x; public int y; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetModuleHandle(string lpModuleName);

    // Kept in static fields: a delegate only referenced by native code would be
    // collected, and the next key press would crash the process.
    static readonly HookProc keyboardProc = OnKeyboard;
    static readonly HookProc mouseProc = OnMouse;
    static IntPtr keyboardHook = IntPtr.Zero;
    static IntPtr mouseHook = IntPtr.Zero;
    public static long BlockedKeys;
    public static long BlockedMouse;

    static IntPtr OnKeyboard(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if ((info.flags & LLKHF_INJECTED) == 0) { BlockedKeys++; return (IntPtr)1; }
        }
        return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
    }

    static IntPtr OnMouse(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if ((info.flags & LLMHF_INJECTED) == 0) { BlockedMouse++; return (IntPtr)1; }
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    public static void Run(int testMinutes) {
        IntPtr module = GetModuleHandle(null);
        keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
        if (keyboardHook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
        if (mouseHook == IntPtr.Zero) {
            UnhookWindowsHookEx(keyboardHook);
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        Timer stopTimer = null;
        if (testMinutes > 0) {
            stopTimer = new Timer { Interval = testMinutes * 60000 };
            stopTimer.Tick += (s, e) => Application.ExitThread();
            stopTimer.Start();
        }
        try {
            // Low-level hooks only fire while this thread pumps messages.
            Application.Run();
        } finally {
            if (stopTimer != null) stopTimer.Dispose();
            UnhookWindowsHookEx(keyboardHook);
            UnhookWindowsHookEx(mouseHook);
        }
    }
}
"@

$host.UI.RawUI.WindowTitle = "Teclado e touchpad do notebook BLOQUEADOS"
Write-Host "Teclado e touchpad do notebook bloqueados. O acesso remoto continua funcionando."
if ($TestMinutes -gt 0) {
  Write-Host "Modo de teste: desbloqueia sozinho em $TestMinutes min."
} else {
  Write-Host "Para desbloquear, feche esta janela pelo acesso remoto."
}

[PhysicalInputBlocker]::Run($TestMinutes)

Write-Host ("Desbloqueado. Teclas ignoradas: {0}. Movimentos/cliques ignorados: {1}." -f [PhysicalInputBlocker]::BlockedKeys, [PhysicalInputBlocker]::BlockedMouse)
