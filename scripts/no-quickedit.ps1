# Turns off "Quick Edit" for this console window. With it on, one mouse click puts the window into
# "Выбрать" (select) mode and Windows pauses the program until Esc is pressed: the tunnel and bot froze that way.
Add-Type -Namespace SetlyWin32 -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint mode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint mode);
'@ -ErrorAction SilentlyContinue
$stdin = [SetlyWin32.Console]::GetStdHandle(-10)
$mode = 0
if ([SetlyWin32.Console]::GetConsoleMode($stdin, [ref]$mode)) {
    # clear ENABLE_QUICK_EDIT_MODE (0x40), set ENABLE_EXTENDED_FLAGS (0x80) so the change sticks
    [void][SetlyWin32.Console]::SetConsoleMode($stdin, ($mode -band (-bnot 0x40)) -bor 0x80)
}
