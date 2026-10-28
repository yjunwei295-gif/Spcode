# 只读查看指定进程，不请求写入或注入权限。
param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference='Stop'
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SpCodeMemory {
 [StructLayout(LayoutKind.Sequential)] public struct MBI {public IntPtr BaseAddress;public IntPtr AllocationBase;public uint AllocationProtect;public UIntPtr RegionSize;public uint State;public uint Protect;public uint Type;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int processId);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h,IntPtr address,byte[] buffer,UIntPtr size,out UIntPtr read);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr h,IntPtr address,out MBI info,UIntPtr size);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public sealed class Region {public string address;public string size;public uint state;public uint protect;public uint type;public bool readable;}
 // 仅开启 QUERY_INFORMATION 与 VM_READ，函数结束释放系统句柄。
 static IntPtr Open(int processId){IntPtr h=OpenProcess(0x410,false,processId);if(h==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());return h;}
 public static byte[] Read(int processId,ulong address,int length){
  IntPtr h=Open(processId);try{byte[] bytes=new byte[length];UIntPtr got;if(!ReadProcessMemory(h,new IntPtr(unchecked((long)address)),bytes,new UIntPtr((uint)length),out got))throw new Win32Exception(Marshal.GetLastWin32Error());if(got.ToUInt64()!=(ulong)length)throw new InvalidOperationException("Partial memory read: "+got);return bytes;}finally{CloseHandle(h);}
 }
 public static Region[] Regions(int processId,ulong address,int limit){
  IntPtr h=Open(processId);var result=new List<Region>();
  try{for(int i=0;i<limit;i++){MBI m;UIntPtr n=VirtualQueryEx(h,new IntPtr(unchecked((long)address)),out m,new UIntPtr((uint)Marshal.SizeOf(typeof(MBI))));if(n==UIntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error==87)break;throw new Win32Exception(error);}ulong start=unchecked((ulong)m.BaseAddress.ToInt64()),size=m.RegionSize.ToUInt64();uint protection=m.Protect&255;result.Add(new Region{address="0x"+start.ToString("X"),size=size.ToString(),state=m.State,protect=m.Protect,type=m.Type,readable=m.State==0x1000&&(m.Protect&0x100)==0&&(protection==2||protection==4||protection==8||protection==32||protection==64||protection==128)});if(size==0||start+size<=address)throw new InvalidOperationException("Invalid region boundary");address=start+size;}return result.ToArray();}finally{CloseHandle(h);}
 }
 // 只搜索调用方指定的区间，不读取其他进程或未知范围。
 public static string[] Search(int processId,ulong address,int length,byte[] pattern,int limit){
  byte[] data=Read(processId,address,length);var hits=new List<string>();for(int i=0;i<=data.Length-pattern.Length;i++){bool match=true;for(int j=0;j<pattern.Length;j++){if(data[i+j]!=pattern[j]){match=false;break;}}if(match){hits.Add("0x"+(address+(ulong)i).ToString("X"));if(hits.Count>=limit)break;}}return hits.ToArray();
 }
}
'@
try {
 switch($request.action){
  'processes' {
   $items=@(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{pid=$_.Id;name=$_.ProcessName;title=$_.MainWindowTitle} })
   $result=@{ok=$true;processes=$items}
  }
  'modules' {
   $process=Get-Process -Id ([int]$request.pid)
   $items=@($process.Modules | ForEach-Object { @{name=$_.ModuleName;address=('0x'+$_.BaseAddress.ToInt64().ToString('X'));size=$_.ModuleMemorySize;path=$_.FileName} })
   $result=@{ok=$true;pid=$process.Id;name=$process.ProcessName;modules=$items}
  }
  'regions' {
   $address=[Convert]::ToUInt64($request.address.Substring(2),16)
   $items=@([SpCodeMemory]::Regions([int]$request.pid,$address,[int]$request.limit))
   $next=$request.address
   if($items.Count -gt 0){$last=$items[-1];$next='0x'+([Convert]::ToUInt64($last.address.Substring(2),16)+[UInt64]$last.size).ToString('X')}
   $result=@{ok=$true;pid=$request.pid;regions=$items;nextAddress=$next;end=($items.Count -lt $request.limit)}
  }
  'read' {
   $address=[Convert]::ToUInt64($request.address.Substring(2),16)
   $bytes=[SpCodeMemory]::Read([int]$request.pid,$address,[int]$request.length)
   $result=@{ok=$true;pid=$request.pid;address=$request.address;length=$bytes.Length;base64=[Convert]::ToBase64String($bytes)}
  }
  'search' {
   $address=[Convert]::ToUInt64($request.address.Substring(2),16)
   $pattern=[Convert]::FromBase64String($request.pattern)
   $hits=@([SpCodeMemory]::Search([int]$request.pid,$address,[int]$request.length,$pattern,[int]$request.limit))
   $result=@{ok=$true;pid=$request.pid;address=$request.address;length=$request.length;matches=$hits;limitReached=($hits.Count -eq $request.limit)}
  }
  default { throw 'Unknown memory operation' }
 }
 $result | ConvertTo-Json -Depth 6 -Compress
} catch {
 @{ok=$false;error=$_.Exception.Message;action=$request.action;pid=$request.pid} | ConvertTo-Json -Compress
 exit 1
}
