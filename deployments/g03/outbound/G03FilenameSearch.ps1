# Loaded by the existing protected Windows connector, never a second agent.
# Only filesystem metadata is enumerated. No index, shell expression or contents.
$script:G03NameClock = [Diagnostics.Stopwatch]::StartNew()
$script:G03NamePages = @{}

function Close-G03NameEnumerator($State) {
    if ($State.Enumerator -is [IDisposable]) { $State.Enumerator.Dispose() }
    $State.Enumerator = $null
}
function Close-G03NameState($State) {
    Close-G03NameEnumerator $State
    foreach($work in $State.Deferred.ToArray()){if($work.Enumerator -is [IDisposable]){$work.Enumerator.Dispose()}}
    $State.Deferred.Clear()
}
function Clear-G03NamePages {
    $now = $script:G03NameClock.ElapsedMilliseconds
    foreach ($key in @($script:G03NamePages.Keys)) {
        $page = $script:G03NamePages[$key]
        if ($page.Expires -le $now) {
            Close-G03NameState $page.State
            $script:G03NamePages.Remove($key)
        }
    }
}
function Assert-G03SearchPolicy {
    # Revocation is checked on every page and again before returning it.
    Assert-G03Protected $ConfigPath $identity.User.Value
    $text = [IO.File]::ReadAllText($ConfigPath)
    Assert-G03 ($text.Length -le 16384) 'SEARCH_POLICY_CHANGED'
    $current = $text | ConvertFrom-Json
    Assert-G03Keys $current @($script:Config.PSObject.Properties.Name)
    foreach ($key in @('installationId','connectionId','policyHash','accountSid','expectedComputer','baseUrl','tokenFile')) {
        Assert-G03 ($current.$key -ceq $script:Config.$key) 'SEARCH_POLICY_CHANGED'
    }
    Assert-G03 (($current.roots | ConvertTo-Json -Compress) -ceq ($script:Config.roots | ConvertTo-Json -Compress)) 'SEARCH_POLICY_CHANGED'
}
function Test-G03NameInRoots([string]$Path, [string[]]$Roots) {
    foreach ($root in $Roots) { if (Test-G03Within $Path $root) { return $true } }
    return $false
}
function Test-G03Filename([string]$Name, [string]$Needle) {
    $nameKey = $Name.Normalize([Text.NormalizationForm]::FormC)
    $needleKey = $Needle.Normalize([Text.NormalizationForm]::FormC)
    if ($nameKey.IndexOf($needleKey,[StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    # Reference normalization preserves every letter and digit, including zeroes.
    # This is a fixed transformation; the caller never supplies a regex/glob.
    if ($needleKey -cmatch '^[A-Za-z0-9 ._-]{3,128}$' -and $needleKey -match '[0-9]') {
        $reference = $needleKey.Replace(' ','').Replace('.','').Replace('_','').Replace('-','')
        $candidate = $nameKey.Replace(' ','').Replace('.','').Replace('_','').Replace('-','')
        return $candidate.IndexOf($reference,[StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    return $false
}
function Lock-G03SearchDirectory([string]$Path) {
    $item = Get-G03SafeItem $Path
    Assert-G03 $item.PSIsContainer 'SEARCH_SOURCE_INACCESSIBLE'
    $handles = New-Object 'Collections.Generic.List[object]'
    try {
        $parent = $Path
        while ($parent) {
            $handles.Add([G03ReadHandle]::Guard($parent))
            $parent = [IO.Path]::GetDirectoryName($parent)
        }
        return ,$handles
    } catch { foreach ($handle in $handles) { $handle.Dispose() }; throw }
}
function Invoke-G03FilenameSearch($Job, [Diagnostics.Stopwatch]$PollClock, [string]$PollId) {
    $guards = $null; $pageToken = $null
    try {
        Assert-G03Keys $Job @('schemaVersion','installationId','connectionId','policyHash','jobId','budgetMs','operation','roots','needle','cursor','binding','limit')
        Assert-G03 ($Job.schemaVersion -eq 2 -and $Job.operation -ceq 'filename_search' -and
            $Job.installationId -ceq $script:Config.installationId -and $Job.connectionId -ceq 'g03' -and
            $Job.policyHash -ceq $script:Config.policyHash -and $Job.binding -cmatch '^[a-f0-9]{64}$' -and
            $Job.jobId -cmatch '^[a-f0-9-]{36}$') 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
        Assert-G03 (($Job.limit -is [int] -or $Job.limit -is [long]) -and $Job.limit -ge 1 -and $Job.limit -le 50 -and
            ($Job.budgetMs -is [int] -or $Job.budgetMs -is [long]) -and $Job.budgetMs -ge 100 -and $Job.budgetMs -le 4000) 'SEARCH_CAPACITY'
        Assert-G03 ($Job.roots -is [Array] -and $Job.roots.Count -ge 1 -and $Job.roots.Count -le 16) 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
        Assert-G03SearchPolicy
        Clear-G03NamePages
        foreach ($root in $Job.roots) {
            Assert-G03 ($root -is [string] -and $root.Length -le 480 -and $root -cmatch '^[A-Z]:\\' -and
                [IO.Path]::GetFullPath($root) -ieq $root -and (Test-G03Allowed $root)) 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
            foreach ($part in $root.Substring(3).Split('\')) { Assert-G03 (Test-G03Segment $part) 'SEARCH_CURSOR_EXPIRED_OR_DENIED' }
        }
        if ($null -eq $Job.cursor) {
            Assert-G03 ($Job.needle -is [string] -and $Job.needle.Length -ge 1 -and $Job.needle.Length -le 128 -and
                $Job.needle -notmatch '[\\/\p{C}]') 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
            Assert-G03 ($script:G03NamePages.Count -lt 128) 'SEARCH_CAPACITY'
            $sessions=New-Object 'Collections.Generic.HashSet[string]'
            foreach($existing in $script:G03NamePages.Values){$null=$sessions.Add($existing.State.Id)}
            Assert-G03 ($sessions.Count -lt 16) 'SEARCH_CAPACITY'
            $queue = New-Object 'Collections.Generic.Queue[string]'
            foreach ($root in $Job.roots) { $queue.Enqueue($root) }
            $state = @{Id=[Guid]::NewGuid().ToString();Roots=@($Job.roots);Needle=$Job.needle;Binding=$Job.binding;Limit=$Job.limit;Queue=$queue;PathBytes=0;
                Seen=(New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase));
                Current=$null;Enumerator=$null;Pending=$null;ScannedEntries=0;ScannedFolders=0;LastChecked=$null;
                Deferred=(New-Object 'Collections.Generic.Queue[object]');
                Buffered=(New-Object 'Collections.Generic.List[object]')}
            $pageToken = [Guid]::NewGuid().ToString()
            $page = @{State=$state;Result=$null;Expires=($script:G03NameClock.ElapsedMilliseconds+600000)}
            $script:G03NamePages[$pageToken] = $page
        } else {
            $pageToken = [string]$Job.cursor
            Assert-G03 ($pageToken -cmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' -and
                $script:G03NamePages.ContainsKey($pageToken) -and $null -eq $Job.needle) 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
            $page = $script:G03NamePages[$pageToken]; $state = $page.State
        }
        Assert-G03 ($state.Binding -ceq $Job.binding -and $state.Limit -eq $Job.limit) 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
        foreach ($root in $state.Roots) { Assert-G03 (Test-G03NameInRoots $root $Job.roots) 'SEARCH_CURSOR_EXPIRED_OR_DENIED' }
        if ($null -ne $page.Result) {
            # Idempotent continuation replay still needs current source evidence.
            $fresh = New-Object 'Collections.Generic.List[object]'
            foreach ($entry in $page.Result.entries) {
                Assert-G03 (Test-G03NameInRoots $entry.source $state.Roots) 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
                $fresh.Add((Get-G03Entry (Get-G03SafeItem $entry.source)))
            }
            if($page.Result.entries.Count -eq 0){$null=Get-G03SafeItem $state.LastChecked}
            Assert-G03SearchPolicy
            $replay=@{}; foreach($key in $page.Result.Keys){$replay[$key]=$page.Result[$key]}
            $replay.entries=@($fresh.ToArray()); $replay.checkedAt=[DateTime]::UtcNow.ToString('o')
            return $replay
        }
        # Preserve observed matches across a cancelled/failed page. Retrying the
        # same cursor cannot silently skip matches already consumed locally.
        $rows = $state.Buffered
        $sourceError = $null; $lastActive = -1000; $checkedThisPage=$false
        while ($rows.Count -lt $Job.limit -and $PollClock.ElapsedMilliseconds -lt ($Job.budgetMs-300)) {
            if ($PollClock.ElapsedMilliseconds - $lastActive -ge 500) {
                $activeTimeout=[Math]::Max(100,[Math]::Min(1000,[int]($Job.budgetMs-$PollClock.ElapsedMilliseconds-100)))
                $active = Invoke-G03Https 'poll' @{schemaVersion=2;installationId=$script:Config.installationId;connectionId='g03';
                    policyHash=$script:Config.policyHash;jobId=$Job.jobId;pollId=$PollId;active=$true} $activeTimeout
                Assert-G03Keys $active @('active')
                Assert-G03 ($active.active -eq $true) 'SEARCH_CANCELLED'
                $lastActive = $PollClock.ElapsedMilliseconds
            }
            if ($null -eq $state.Current) {
                if ($state.Queue.Count -gt 0) { $state.Current = $state.Queue.Dequeue() }
                elseif($state.Deferred.Count -gt 0){
                    $work=$state.Deferred.Dequeue();$state.Current=$work.Current;$state.Enumerator=$work.Enumerator;$state.Pending=$work.Pending
                }else{break}
                if ($state.Seen.Contains($state.Current)) { $state.Current=$null; continue }
            }
            if ($null -eq $guards) {
                Assert-G03 (Test-G03NameInRoots $state.Current $state.Roots) 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
                try {
                    $guards = Lock-G03SearchDirectory $state.Current
                    $checkedThisPage=$true; $state.LastChecked=$state.Current
                    if ($null -eq $state.Enumerator) {
                        $directory = Get-G03SafeItem $state.Current
                        $state.Enumerator = $directory.EnumerateFileSystemInfos().GetEnumerator()
                    }
                } catch { $sourceError='SEARCH_SOURCE_INACCESSIBLE'; break }
            }
            if ($null -eq $state.Pending) {
                try { $more = $state.Enumerator.MoveNext() } catch { $sourceError='SEARCH_SOURCE_INACCESSIBLE'; break }
                if (-not $more) {
                    Close-G03NameEnumerator $state; $null=$state.Seen.Add($state.Current)
                    $state.ScannedFolders++; $state.Current=$null
                    foreach ($handle in $guards) { $handle.Dispose() }; $guards=$null
                    continue
                }
                $state.Pending = $state.Enumerator.Current
                $state.ScannedEntries++
                Assert-G03 ($state.ScannedEntries -le 100000) 'SEARCH_CAPACITY'
            }
            $item = $state.Pending
            if (-not (Test-G03Segment $item.Name) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $state.Pending=$null; continue }
            Assert-G03 (Test-G03NameInRoots $item.FullName $state.Roots) 'SEARCH_CURSOR_EXPIRED_OR_DENIED'
            $folder = [bool]($item.Attributes -band [IO.FileAttributes]::Directory)
            $match = Test-G03Filename $item.Name $state.Needle
            if ($folder -or $match) {
                try { $verified = Get-G03SafeItem $item.FullName }
                catch { $sourceError='SEARCH_SOURCE_INACCESSIBLE'; break }
                if ($folder) {
                    Assert-G03 ($state.Queue.Count -lt 4096) 'SEARCH_CAPACITY'
                    Assert-G03 (($state.PathBytes + $verified.FullName.Length*2) -le 2MB) 'SEARCH_CAPACITY'
                    $state.Queue.Enqueue($verified.FullName)
                    $state.PathBytes += $verified.FullName.Length*2
                }
                if ($match) { $rows.Add((Get-G03Entry $verified)) }
            }
            $state.Pending=$null
        }
        Assert-G03SearchPolicy
        if($sourceError -and $null -ne $state.Current){
            Assert-G03 ($state.Deferred.Count -lt 16) 'SEARCH_CAPACITY'
            $state.Deferred.Enqueue(@{Current=$state.Current;Enumerator=$state.Enumerator;Pending=$state.Pending})
            $state.Current=$null;$state.Enumerator=$null;$state.Pending=$null
        }
        if(-not $checkedThisPage -and $rows.Count -eq 0){throw $(if($sourceError){$sourceError}else{'SEARCH_SOURCE_BUSY'})}
        foreach($row in $rows){$null=Get-G03SafeItem $row.source}
        $pending = $state.Queue.Count + $state.Deferred.Count + $(if($null -ne $state.Current){1}else{0})
        $next = $null
        if ($pending -gt 0) {
            Assert-G03 ($script:G03NamePages.Count -lt 128) 'SEARCH_CAPACITY'
            $next=[Guid]::NewGuid().ToString()
            $script:G03NamePages[$next]=@{State=$state;Result=$null;Expires=$page.Expires}
        } else { Close-G03NameState $state }
        $result=@{ok=$true;checkedAt=[DateTime]::UtcNow.ToString('o');entries=@($rows.ToArray());nextCursor=$next;limited=($null -ne $next);
            coverage=@{complete=($null -eq $next);snapshot=$false;scannedEntries=$state.ScannedEntries;scannedFolders=$state.ScannedFolders;pendingFolders=$pending}}
        if ($sourceError -or $state.Deferred.Count -gt 0) { $result.error='SEARCH_SOURCE_INACCESSIBLE' }
        $page.Result=$result
        $state.Buffered=New-Object 'Collections.Generic.List[object]'
        return $result
    } catch {
        $code=$_.Exception.Message
        if ($code -notin @('SEARCH_SOURCE_INACCESSIBLE','SEARCH_SOURCE_BUSY','SEARCH_CANCELLED','SEARCH_CURSOR_EXPIRED_OR_DENIED','SEARCH_POLICY_CHANGED','SEARCH_CAPACITY')) { $code='SEARCH_SOURCE_INACCESSIBLE' }
        if ($Job.PSObject.Properties['cursor'] -and $null -eq $Job.cursor -and $pageToken) {
            if ($script:G03NamePages.ContainsKey($pageToken)) {
                Close-G03NameState $script:G03NamePages[$pageToken].State
                $script:G03NamePages.Remove($pageToken)
            }
        }
        return @{ok=$false;error=$code}
    } finally { if($guards){foreach($handle in $guards){$handle.Dispose()}} }
}
