#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath, [switch]$CheckOnly, [switch]$TransportCheckOnly, [switch]$QaIsolated)

# Fixed program: browse/read/create/replace/receipt only; input is data, never code.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$MaximumBytes = 16MB
$AllowedFormats = @('.pptx', '.accdb', '.pdf','.docx','.xlsx','.xlsm','.asc','.txt','.csv','.md','.json')

function Assert-G03($Condition, [string]$Code = 'PATH_DENIED') {
    if (-not $Condition) { throw $Code }
}
function Test-G03Segment([string]$Name) {
    if ([string]::IsNullOrEmpty($Name) -or $Name.Length -gt 255 -or $Name.StartsWith('.') -or
        $Name -match '[\\/:*?<>|"%\p{C}]' -or $Name -match '[. ]$' -or
        $Name -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$' -or
        $Name -match '(^|[._ -])(secrets?|credentials?|passwords?|passwd|tokens?|private.?key|backups?|c[o\u00f2]pies|copias)([._ -]|$)') { return $false }
    return $true
}
function Test-G03Within([string]$Path, [string]$Root) {
    return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Test-G03Allowed([string]$Path, [bool]$Ancestors = $false) {
    foreach ($root in $script:Config.roots) {
        if ((Test-G03Within $Path $root) -or ($Ancestors -and (Test-G03Within $root $Path))) { return $true }
    }
    return $false
}
function Assert-G03Keys($Object, [string[]]$Keys) {
    $actual = @($Object.PSObject.Properties.Name | Sort-Object)
    Assert-G03 (($actual -join '|') -ceq (($Keys | Sort-Object) -join '|')) 'INVALID_REQUEST'
}
function Assert-G03Protected([string]$Path, [string]$ReaderSid) {
    $item = Get-Item -LiteralPath $Path -Force
    Assert-G03 (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'UNSAFE_CONFIG'
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Assert-G03 ($owner -in @('S-1-5-18','S-1-5-32-544')) 'UNSAFE_CONFIG_OWNER'
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $rule.IdentityReference.Value
        # Config and token are private; only SYSTEM/Admins can change the program.
        Assert-G03 ($sid -in @('S-1-5-18','S-1-5-32-544',$ReaderSid)) 'UNSAFE_CONFIG_ACL'
        if ($sid -eq $ReaderSid) {
            $write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
                [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            Assert-G03 (-not ($rule.FileSystemRights -band $write)) 'WRITABLE_CONFIG'
        }
    }
}

Assert-G03 ($env:OS -eq 'Windows_NT') 'WINDOWS_REQUIRED'
Assert-G03 ([Diagnostics.Stopwatch]::IsHighResolution) 'MONOTONIC_CLOCK_REQUIRED'
Assert-G03 ([IO.Path]::IsPathRooted($ConfigPath)) 'ABSOLUTE_CONFIG_REQUIRED'
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$raw = [IO.File]::ReadAllText($ConfigPath)
Assert-G03 ($raw.Length -le 16384) 'CONFIG_TOO_LARGE'
$script:Config = $raw | ConvertFrom-Json
Assert-G03Keys $script:Config @('schemaVersion','installationId','connectionId','baseUrl','policyHash','expectedComputer','accountSid','tokenFile','roots','writesEnabled','writeStateDirectory')
Assert-G03 ($script:Config.schemaVersion -eq 1 -and $script:Config.installationId -cmatch '^g03[a-z0-9-]{0,59}$' -and
    $script:Config.connectionId -ceq 'g03' -and $script:Config.policyHash -cmatch '^[a-f0-9]{64}$') 'INVALID_CONFIG'
Assert-G03 ($env:COMPUTERNAME -ieq $script:Config.expectedComputer) 'WRONG_COMPUTER'
$endpoint = $null
Assert-G03 ([Uri]::TryCreate($script:Config.baseUrl,[UriKind]::Absolute,[ref]$endpoint) -and
    $endpoint.Scheme -ceq 'https' -and $endpoint.Port -eq 443 -and -not $endpoint.UserInfo -and
    -not $endpoint.Query -and -not $endpoint.Fragment -and $endpoint.AbsolutePath -ceq '/g03-files/v1') 'WRONG_ENDPOINT'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
Assert-G03 ($identity.User.Value -eq $script:Config.accountSid -and
    -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
    $identity.User.Value -notin @('S-1-5-18','S-1-5-19','S-1-5-20')) 'DEDICATED_NON_ADMIN_ACCOUNT_REQUIRED'
Assert-G03 ($script:Config.roots -is [Array] -and $script:Config.roots.Count -ge 1 -and $script:Config.roots.Count -le 16) 'INVALID_ROOTS'
foreach ($root in $script:Config.roots) {
    Assert-G03 ($root -cmatch '^[A-Z]:\\.+' -and $root.Length -le 480 -and -not $root.EndsWith('\')) 'INVALID_ROOT'
    foreach ($part in $root.Substring(3).Split('\')) { Assert-G03 (Test-G03Segment $part) 'INVALID_ROOT' }
    Assert-G03 ($root -notmatch '^C:\\(Windows|Users|ProgramData|Program Files)(\\|$)') 'INVALID_ROOT'
    # Mapped employee drives must never silently become service-account sources.
    $drive = New-Object IO.DriveInfo($root.Substring(0,3))
    Assert-G03 ($drive.DriveType -eq [IO.DriveType]::Fixed) 'ROOT_NOT_LOCAL_VOLUME'
    if ($script:Config.writesEnabled) { Assert-G03 ($drive.DriveFormat -ceq 'NTFS') 'WRITE_ATOMIC_UNAVAILABLE' }
}
$programDirectory = [IO.Path]::GetDirectoryName($PSCommandPath)
Assert-G03 ([IO.Path]::GetDirectoryName($ConfigPath) -ieq $programDirectory) 'CONFIG_LOCATION'
Assert-G03 ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($script:Config.tokenFile)) -ieq $programDirectory) 'TOKEN_LOCATION'
$writeCore = [IO.Path]::Combine($programDirectory,'G03WriteCore.ps1')
$searchCore = [IO.Path]::Combine($programDirectory,'G03FilenameSearch.ps1')
foreach ($file in @($programDirectory,$PSCommandPath,$writeCore,$searchCore,$ConfigPath,$script:Config.tokenFile)) {
    Assert-G03Protected $file $identity.User.Value
}
$token = [IO.File]::ReadAllText($script:Config.tokenFile).Trim()
Assert-G03 ($token -cmatch '^[A-Za-z0-9_-]{43,128}$') 'INVALID_TOKEN'

# Check the *opened handle*, not just the name before opening: deny junctions,
# alternate streams and races replacing a parent with a link outside the roots.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class G03ReadHandle {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint attrs, c1,c2,a1,a2,w1,w2,volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    public static SafeFileHandle Open(string path, bool read) { return Checked(path, read ? 0x80000000u : 0u, 7, 3); }
    public static SafeFileHandle Guard(string path) { return Checked(path, 0u, 3, 3); }
    public static SafeFileHandle Writer(string path, bool create) { return Checked(path, 0xC0000000u, 0, create ? 1u : 3u); }
    public static SafeFileHandle Snapshot(string path) { return Checked(path, 0x80000000u, 1, 3); }
    static SafeFileHandle Checked(string path, uint access, uint share, uint creation) {
        var h = CreateFile(path, access, share, IntPtr.Zero, creation, 0x02200000, IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); throw new IOException("WINDOWS_PATH_UNAVAILABLE"); }
        return Validate(h,path);
    }
    public static SafeFileHandle Validate(SafeFileHandle h, string path) {
        var b = new StringBuilder(1024);
        uint n = GetFinalPathNameByHandle(h, b, 1024, 0);
        Info info;
        if (!GetFileInformationByHandle(h, out info) || (info.attrs & 0x400) != 0 ||
            ((info.attrs & 0x10) == 0 && info.links != 1) || n == 0 || n >= 1024 ||
            !String.Equals(b.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase)) {
            h.Dispose(); throw new IOException("PATH_DENIED");
        }
        return h;
    }
}
// Legacy Windows/NTFS-only atomic write boundary. No ordinary in-place fallback.
// TxF is deprecated by Microsoft: feature-test it on every destination volume
// and requalify this connector when the customer's server is replaced.
public sealed class G03FileTransaction : IDisposable {
    [DllImport("KtmW32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateTransaction(IntPtr security, IntPtr guid,
        uint options, uint isolation, uint isolationFlags, uint timeout, string description);
    [DllImport("KtmW32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CommitTransaction(SafeFileHandle transaction);
    [DllImport("KtmW32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool RollbackTransaction(SafeFileHandle transaction);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileTransacted(string name, uint access,
        uint share, IntPtr security, uint creation, uint flags, IntPtr template,
        SafeFileHandle transaction, IntPtr miniVersion, IntPtr extended);
    readonly SafeFileHandle transaction;
    bool completed;
    public G03FileTransaction() {
        transaction = CreateTransaction(IntPtr.Zero,IntPtr.Zero,0,0,0,55000,"G03 bounded document publication");
        if (transaction.IsInvalid) { transaction.Dispose(); throw new IOException("WRITE_ATOMIC_UNAVAILABLE"); }
    }
    public FileStream Open(string path, bool create) {
        if (completed) throw new IOException("WRITE_QUARANTINED");
        var h = CreateFileTransacted(@"\\?\"+path,0xC0000000u,0,IntPtr.Zero,
            create ? 1u : 3u,0x80200000u,IntPtr.Zero,transaction,IntPtr.Zero,IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); throw new IOException("WRITE_SOURCE_BUSY"); }
        try { return new FileStream(G03ReadHandle.Validate(h,path),FileAccess.ReadWrite); }
        catch { h.Dispose(); throw; }
    }
    public void Commit() {
        if (completed || !CommitTransaction(transaction)) throw new IOException("WRITE_QUARANTINED");
        completed=true;
    }
    public void Rollback() {
        if (completed) throw new IOException("WRITE_QUARANTINED");
        if (!RollbackTransaction(transaction)) throw new IOException("WRITE_QUARANTINED");
        completed=true;
    }
    public void Dispose() {
        if (!completed) RollbackTransaction(transaction);
        transaction.Dispose();
    }
}
'@
. $writeCore

function New-G03FileTransaction { return New-Object G03FileTransaction }

function Lock-G03PublishParents([string]$Target) {
    Assert-G03 (Test-G03Allowed $Target)
    foreach ($part in $Target.Substring(3).Split('\')) { Assert-G03 (Test-G03Segment $part) }
    Assert-G03 ($Target.Length -le 480 -and [IO.Path]::GetFullPath($Target) -ieq $Target)
    $parent = [IO.Path]::GetDirectoryName($Target)
    $null = Get-G03SafeItem $parent $true
    $handles = New-Object 'Collections.Generic.List[object]'
    try {
        while ($parent) {
            $i = Get-Item -LiteralPath $parent -Force
            Assert-G03 ($i.PSIsContainer -and -not ($i.Attributes -band [IO.FileAttributes]::ReparsePoint))
            $handles.Add([G03ReadHandle]::Guard($parent))
            $parent = [IO.Path]::GetDirectoryName($parent)
        }
        return ,$handles
    } catch { foreach($h in $handles){$h.Dispose()}; throw }
}
function Open-G03PublishStream([string]$Target, [bool]$Create) {
    $h = [G03ReadHandle]::Writer($Target,$Create)
    try { return New-Object IO.FileStream($h,[IO.FileAccess]::ReadWrite) }
    catch { $h.Dispose(); throw }
}
function Open-G03SnapshotStream([string]$Target) {
    $h = [G03ReadHandle]::Snapshot($Target)
    try { return New-Object IO.FileStream($h,[IO.FileAccess]::Read) }
    catch { $h.Dispose(); throw }
}

function Get-G03SafeItem([string]$Path, [bool]$Ancestors = $false) {
    Assert-G03 ($Path -cmatch '^[A-Z]:\\' -and $Path.Length -le 480)
    Assert-G03 (Test-G03Allowed $Path.TrimEnd('\') $Ancestors)
    foreach ($part in $Path.Substring(3).TrimEnd('\').Split('\')) {
        if ($part) { Assert-G03 (Test-G03Segment $part) }
    }
    Assert-G03 ([IO.Path]::GetFullPath($Path) -ieq $Path)
    $p = $Path
    while ($p) {
        $i = Get-Item -LiteralPath $p -Force
        Assert-G03 (-not ($i.Attributes -band [IO.FileAttributes]::ReparsePoint))
        $p = [IO.Path]::GetDirectoryName($p)
    }
    $handle = [G03ReadHandle]::Open($Path,$false)
    try { return Get-Item -LiteralPath $Path -Force } finally { $handle.Dispose() }
}
function Get-G03Entry($Item) {
    $folder = [bool]$Item.PSIsContainer
    return @{source=$Item.FullName.TrimEnd('\');name=$Item.Name;kind=$(if($folder){'directory'}else{'file'});
        size=$(if($folder){0}else{$Item.Length});modifiedAt=$Item.LastWriteTimeUtc.ToString('o')}
}
function Invoke-G03ReadOnly($Job, [Diagnostics.Stopwatch]$PollClock) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        Assert-G03 ($Job.operation -in @('browse','read','snapshot','create','replace','receipt')) 'INVALID_REQUEST'
        $expectedKeys = @('schemaVersion','installationId','connectionId','policyHash','jobId','budgetMs','operation','source')
        if ($Job.operation -eq 'browse') { $expectedKeys += @('offset','limit') }
        elseif ($Job.operation -eq 'read') { $expectedKeys += 'part' }
        elseif ($Job.operation -eq 'snapshot') { }
        elseif ($Job.operation -eq 'receipt') { $expectedKeys += @('writeOperation','operationId','expectedSha256','sha256','actorId','projectId') }
        else { $expectedKeys += @('operationId','expectedSha256','sha256','base64','actorId','projectId') }
        Assert-G03Keys $Job $expectedKeys
        Assert-G03 ($Job.schemaVersion -eq 2 -and $Job.installationId -ceq $script:Config.installationId -and
            $Job.connectionId -ceq 'g03' -and $Job.policyHash -ceq $script:Config.policyHash -and
            $Job.jobId -cmatch '^[a-f0-9-]{36}$') 'INVALID_REQUEST'
        Initialize-G03Deadline $Job $PollClock
        if ($Job.operation -eq 'snapshot') { return Get-G03PublicationSnapshot $Job }
        if ($Job.operation -eq 'receipt') {
            Assert-G03 ($Job.source -cmatch '^[A-Z]:\\' -and $Job.source.Length -le 480) 'PATH_DENIED'
            Assert-G03 (Test-G03Allowed $Job.source) 'PATH_DENIED'
            foreach ($part in $Job.source.Substring(3).Split('\')) { Assert-G03 (Test-G03Segment $part) 'PATH_DENIED' }
            Assert-G03 ([IO.Path]::GetFullPath($Job.source) -ieq $Job.source) 'PATH_DENIED'
            return Get-G03PublicationReceipt $Job
        }
        if ($Job.operation -in @('create','replace')) { return Invoke-G03Publish $Job }
        if ($Job.operation -eq 'browse') {
            Assert-G03 ($Job.limit -is [int] -or $Job.limit -is [long]) 'INVALID_REQUEST'
            Assert-G03 ($Job.offset -is [int] -or $Job.offset -is [long]) 'INVALID_REQUEST'
            Assert-G03 ($Job.limit -ge 1 -and $Job.limit -le 50 -and $Job.offset -ge 0 -and $Job.offset -lt 50000) 'INVALID_REQUEST'
            $items = New-Object 'Collections.Generic.List[object]'
            if ($Job.source -eq '') {
                foreach ($drive in @($script:Config.roots | ForEach-Object { $_.Substring(0,3) } | Sort-Object -Unique)) {
                    # Touch an authorized root to avoid claiming an offline drive is live.
                    $root = @($script:Config.roots | Where-Object { $_.StartsWith($drive) })[0]
                    $null = Get-G03SafeItem $root
                    $items.Add(@{source=$drive;name=$drive.Substring(0,1);kind='directory';size=0;modifiedAt=$null})
                }
            } elseif (-not (Test-G03Allowed $Job.source.TrimEnd('\'))) {
                # Virtual ancestors reveal only the next component of approved roots.
                Assert-G03 (Test-G03Allowed $Job.source.TrimEnd('\') $true)
                $children = @($script:Config.roots | Where-Object { Test-G03Within $_ $Job.source.TrimEnd('\') } | ForEach-Object {
                    $prefix = $Job.source.TrimEnd('\') + '\'
                    $prefix + $_.Substring($prefix.Length).Split('\')[0]
                } | Sort-Object -Unique)
                foreach ($child in $children) { $items.Add((Get-G03Entry (Get-G03SafeItem $child $true))) }
            } else {
                $directory = Get-G03SafeItem $Job.source
                Assert-G03 ($directory.PSIsContainer)
                $count = 0
                foreach ($i in $directory.EnumerateFileSystemInfos()) {
                    $count++
                    Assert-G03 ($count -le 50000 -and $clock.Elapsed.TotalSeconds -lt 20) 'DIRECTORY_LIMIT'
                    if (-not (Test-G03Segment $i.Name) -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
                    try { $items.Add((Get-G03Entry (Get-G03SafeItem $i.FullName))) } catch { continue }
                }
                $null = Get-G03SafeItem $Job.source
            }
            $sorted = @($items | Sort-Object { $_.name.ToUpperInvariant() }, { $_.name })
            $entries = @($sorted | Select-Object -Skip $Job.offset -First $Job.limit)
            $more = ($Job.offset + $Job.limit) -lt $sorted.Count
            Assert-G03Deadline $Job
            return @{ok=$true;checkedAt=[DateTime]::UtcNow.ToString('o');entries=$entries;limited=$more;
                nextOffset=$(if($more){$Job.offset+$Job.limit}else{$null})}
        }
        Assert-G03 ([IO.Path]::GetExtension($Job.source).ToLowerInvariant() -in $AllowedFormats) 'SERVER_FORMAT_NOT_READABLE'
        $before = Get-G03SafeItem $Job.source
        Assert-G03 (-not $before.PSIsContainer -and $before.Length -gt 0 -and $before.Length -le $MaximumBytes) 'SERVER_COPY_LIMIT'
        $handle = [G03ReadHandle]::Open($Job.source,$true)
        $stream = $null; $memory = New-Object IO.MemoryStream
        try {
            $stream = New-Object IO.FileStream($handle,[IO.FileAccess]::Read)
            $buffer = New-Object byte[] 65536
            while (($n = $stream.Read($buffer,0,$buffer.Length)) -gt 0) {
                Assert-G03 (($memory.Length + $n) -le $MaximumBytes -and $clock.Elapsed.TotalSeconds -lt 20) 'SERVER_COPY_LIMIT'
                Assert-G03Deadline $Job
                $memory.Write($buffer,0,$n)
            }
            $bytes = $memory.ToArray()
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()
                # A second read of the same verified handle detects concurrent writers.
                $null = $stream.Seek(0,[IO.SeekOrigin]::Begin)
                $secondHash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
            } finally { $sha.Dispose() }
            Assert-G03 ($hash -ceq $secondHash) 'SERVER_SOURCE_CHANGED'
        } finally { if($stream){$stream.Dispose()}; $handle.Dispose(); $memory.Dispose() }
        $after = Get-G03SafeItem $Job.source
        Assert-G03 ($bytes.Length -eq $before.Length -and $after.Length -eq $before.Length -and
            $after.LastWriteTimeUtc -eq $before.LastWriteTimeUtc) 'SERVER_SOURCE_CHANGED'
        Assert-G03Deadline $Job
        return @{ok=$true;checkedAt=[DateTime]::UtcNow.ToString('o');source=$Job.source;bytes=$bytes.Length;
            sha256=$hash;modifiedAt=$after.LastWriteTimeUtc.ToString('o');base64=[Convert]::ToBase64String($bytes)}
    } catch {
        $code = $_.Exception.Message
        if ($code -notin @('PATH_DENIED','SERVER_SOURCE_CHANGED','SERVER_COPY_LIMIT','SERVER_FORMAT_NOT_READABLE','CONNECTOR_DEADLINE','DIRECTORY_LIMIT',
            'WRITE_DISABLED','WRITE_ATOMIC_UNAVAILABLE','WRITE_CONFLICT','WRITE_QUARANTINED','WRITE_FAILED_RESTORED','WRITE_OPERATION_CONFLICT','WRITE_SOURCE_BUSY','WRITE_CAPACITY')) { $code = 'WINDOWS_PATH_UNAVAILABLE' }
        return @{ok=$false;error=$code}
    }
}
function Invoke-G03Https([string]$Action, $Body, [int]$TimeoutMs = 20000) {
    Assert-G03 ($Action -in @('poll','result'))
    $request = [Net.HttpWebRequest]::Create($script:Config.baseUrl + '/' + $Action)
    $request.Method = 'POST'; $request.ContentType = 'application/json; charset=utf-8'
    Assert-G03 ($TimeoutMs -ge 100 -and $TimeoutMs -le 20000) 'INVALID_REQUEST'
    $request.AllowAutoRedirect = $false; $request.Timeout = $TimeoutMs; $request.ReadWriteTimeout = $TimeoutMs
    $request.UseDefaultCredentials = $false; $request.PreAuthenticate = $false
    $request.MaximumResponseHeadersLength = 16
    $request.Headers['Authorization'] = 'Bearer ' + $token
    $payload = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 12 -Compress))
    $request.ContentLength = $payload.Length
    $out = $request.GetRequestStream()
    try { $out.Write($payload,0,$payload.Length) } finally { $out.Dispose() }
    $response = $request.GetResponse()
    try {
        Assert-G03 ([int]$response.StatusCode -eq 200) 'HTTPS_REJECTED'
        $reader = New-Object IO.StreamReader($response.GetResponseStream(),[Text.Encoding]::UTF8)
        try {
            $chars = New-Object char[] 8192
            $text = New-Object Text.StringBuilder
            while (($n = $reader.Read($chars,0,$chars.Length)) -gt 0) {
                Assert-G03 (($text.Length + $n) -le 23MB) 'HTTPS_RESPONSE_LIMIT'
                $null = $text.Append($chars,0,$n)
            }
            return ($text.ToString() | ConvertFrom-Json)
        } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

. $searchCore

foreach ($root in $script:Config.roots) { $null = Get-G03SafeItem $root }
Assert-G03 ($script:Config.writesEnabled -is [bool]) 'INVALID_WRITE_POLICY'
if ($script:Config.writesEnabled) {
    $state = Get-Item -LiteralPath $script:Config.writeStateDirectory -Force
    Assert-G03 ($state.PSIsContainer -and -not ($state.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
        $state.FullName -ieq [IO.Path]::Combine($programDirectory,'versions')) 'INVALID_WRITE_STATE'
    $acl = Get-Acl -LiteralPath $state.FullName
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
            Assert-G03 ($rule.IdentityReference.Value -in @('S-1-5-18','S-1-5-32-544',$identity.User.Value)) 'UNSAFE_WRITE_STATE'
        }
    }
}
if ($QaIsolated) {
    Assert-G03 ($script:Config.installationId -cmatch '^g03-qa-[a-z0-9-]{1,55}$' -and
        $script:Config.writesEnabled -eq $false) 'READ_ONLY_QA_IDENTITY_REQUIRED'
}
if ($CheckOnly) {
    Write-Output 'LOCAL_PREFLIGHT_OK: computer, dedicated account, private config and local roots verified. No network request performed.'
    exit 0
}
$mutexName = 'Global\G03AiBrainConnector'
if ($QaIsolated) {
    # A QA policy has a different installation and hash. The production relay
    # rejects it before consuming a job; the legacy production mutex is intact.
    $mutexName = 'Global\G03AiBrainFilenameQA-' + $script:Config.policyHash.Substring(0,24)
}
$mutex = New-Object Threading.Mutex($false, $mutexName)
Assert-G03 ($mutex.WaitOne(0)) 'CONNECTOR_ALREADY_RUNNING'
$previousTls = [Net.ServicePointManager]::SecurityProtocol
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
$seen = New-Object 'Collections.Generic.HashSet[string]'
$failures = 0
$filenameCapability = $true
try {
    if ($TransportCheckOnly) {
        $nonce = [Guid]::NewGuid().ToString('N')
        $probeClock = [Diagnostics.Stopwatch]::StartNew()
        $probe = Invoke-G03Https 'poll' @{schemaVersion=2;installationId=$script:Config.installationId;
            connectionId='g03';policyHash=$script:Config.policyHash;pollId=$nonce;probe=$true}
        Assert-G03Keys $probe @('schemaVersion','pollId','job','probe')
        Assert-G03 ($probe.schemaVersion -eq 2 -and $probe.pollId -ceq $nonce -and
            $probe.probe -eq $true -and $null -eq $probe.job -and
            $probeClock.Elapsed.TotalSeconds -lt 20) 'TRANSPORT_PROBE_FAILED'
        $proof = @{schemaVersion=2;computer=$env:COMPUTERNAME;accountSid=$identity.User.Value;
            policyHash=$script:Config.policyHash;checkedAt=[DateTime]::UtcNow.ToString('o');
            connectorHash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();
            coreHash=(Get-FileHash -LiteralPath $writeCore -Algorithm SHA256).Hash.ToLowerInvariant();
            kind='authenticated-monotonic-transport-v2';customerDocumentAcceptance=$false}
        Write-G03NewPrivateFile ([IO.Path]::Combine($script:Config.writeStateDirectory,'clock-protocol-qualification.json')) `
            ([Text.Encoding]::UTF8.GetBytes(($proof | ConvertTo-Json -Compress)))
        Write-Output 'TRANSPORT_V2_VERIFIED: dedicated account, HTTPS and nonce verified. No customer document accessed.'
        return
    }
    while ($true) {
        try {
            Assert-G03 ([Diagnostics.Process]::GetCurrentProcess().PrivateMemorySize64 -lt 384MB) 'MEMORY_LIMIT'
            $pollId = [Guid]::NewGuid().ToString('N')
            $pollClock = [Diagnostics.Stopwatch]::StartNew()
            $pollBody = @{schemaVersion=2;installationId=$script:Config.installationId;
                connectionId='g03';policyHash=$script:Config.policyHash;pollId=$pollId}
            if ($filenameCapability) { $pollBody.capabilities = @('filename_search_v1') }
            try { $reply = Invoke-G03Https 'poll' $pollBody }
            catch [Net.WebException] {
                # An old relay rejects the optional field before consuming a job.
                if ($filenameCapability -and $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 400) {
                    $filenameCapability = $false; $pollBody.Remove('capabilities')
                    $reply = Invoke-G03Https 'poll' $pollBody
                } else { throw }
            }
            Assert-G03Keys $reply @('schemaVersion','pollId','job')
            Assert-G03 ($reply.schemaVersion -eq 2 -and $reply.pollId -ceq $pollId -and
                $pollClock.Elapsed.TotalSeconds -lt 20) 'POLL_BINDING_REJECTED'
            if ($null -ne $reply.job) {
                Assert-G03 ($seen.Add([string]$reply.job.jobId)) 'REPLAYED_JOB'
                Assert-G03 ($seen.Count -le 10000) 'SESSION_LIMIT'
                if ($reply.job.operation -ceq 'filename_search') {
                    $result = Invoke-G03FilenameSearch $reply.job $pollClock $pollId
                } else { $result = Invoke-G03ReadOnly $reply.job $pollClock }
                if ($result.ok -and $reply.job.operation -cne 'filename_search') { Assert-G03Deadline $reply.job }
                $accepted = Invoke-G03Https 'result' @{schemaVersion=2;installationId=$script:Config.installationId;connectionId='g03';
                    policyHash=$script:Config.policyHash;jobId=$reply.job.jobId;pollId=$pollId;result=$result}
                Assert-G03Keys $accepted @('accepted')
                Assert-G03 ($accepted.accepted -eq $true -or $reply.job.operation -ceq 'filename_search') 'RESULT_NOT_ACCEPTED'
            } else { Start-Sleep -Seconds 2 }
            $failures = 0
        } catch {
            # Bounded reconnect. No raw exceptions (URLs, paths, headers) in logs.
            $failures++
            Write-Warning 'CONNECTOR_REQUEST_FAILED: no confirmed result. Do not retry a write with a new operation ID.'
            if ($failures -ge 8 -or $seen.Count -ge 10000) { throw 'CONNECTOR_STOPPED_REVIEW_REQUIRED' }
            Start-Sleep -Seconds ([Math]::Min(30,2*$failures))
        }
    }
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousTls
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
