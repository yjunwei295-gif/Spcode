# Read GitHub token from Windows Credential Manager (GCM store) for release upload.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File read-gh-cred.ps1

$CsharpCode = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinCredReader
{
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string ReadSecret(string target)
    {
        IntPtr ptr;
        if (!CredReadW(target, 1, 0, out ptr))
        {
            return "ERR:" + Marshal.GetLastWin32Error();
        }

        CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
        int size = cred.CredentialBlobSize;
        byte[] buf = new byte[size];
        if (size > 0)
        {
            Marshal.Copy(cred.CredentialBlob, buf, 0, size);
        }

        CredFree(ptr);
        return "USER=" + cred.UserName + " LEN=" + size + " SECRET=" + Decode(buf);
    }

    private static string Decode(byte[] buf)
    {
        if (buf.Length == 0)
        {
            return "";
        }

        string utf8 = Encoding.UTF8.GetString(buf).TrimEnd('\0');
        if (IsPrintable(utf8))
        {
            return utf8;
        }

        string utf16 = Encoding.Unicode.GetString(buf).TrimEnd('\0');
        return utf16;
    }

    private static bool IsPrintable(string s)
    {
        foreach (char c in s)
        {
            if (c < 33 || c > 126)
            {
                return false;
            }
        }

        return s.Length > 0;
    }
}
'@

Add-Type -TypeDefinition $CsharpCode

Write-Output ([WinCredReader]::ReadSecret("git:https://github.com"))
