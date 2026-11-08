# Fixed publication implementation, loaded by G03Connector.ps1; no delete verb.
# Windows path/ACL/handle guards are supplied by the connector, not by requests.
function Initialize-G03Deadline($Job, [Diagnostics.Stopwatch]$PollClock) {
    # Clock starts BEFORE the authenticated HTTPS poll. Subtracting the entire
    # round trip is conservative: network delay can shorten, never renew a job.
    Assert-G03 ($Job.schemaVersion -eq 2 -and $Job.jobId -cmatch '^[a-f0-9-]{36}$') 'INVALID_REQUEST'
    Assert-G03 ([Diagnostics.Stopwatch]::IsHighResolution -and
        ($Job.budgetMs -is [int] -or $Job.budgetMs -is [long]) -and
        $Job.budgetMs -gt 0 -and $Job.budgetMs -le 55000 -and
        $null -ne $PollClock -and $PollClock.IsRunning) 'CONNECTOR_DEADLINE'
    Assert-G03 ($null -eq $Job.PSObject.Properties['G03LocalDeadline']) 'INVALID_REQUEST'
    $Job | Add-Member -MemberType NoteProperty -Name G03LocalDeadline -Value @{
        jobId=$Job.jobId; budgetMs=[long]$Job.budgetMs; clock=$PollClock
    }
    Assert-G03Deadline $Job
}
function Assert-G03Deadline($Job) {
    # Only the local program can attach a running Stopwatch; JSON cannot.
    $context = $Job.G03LocalDeadline
    Assert-G03 ($null -ne $context -and $context.jobId -ceq $Job.jobId -and
        $context.clock -is [Diagnostics.Stopwatch] -and $context.clock.IsRunning -and
        $context.budgetMs -gt 0 -and $context.budgetMs -le 55000 -and
        $context.clock.Elapsed.TotalMilliseconds -lt $context.budgetMs) 'CONNECTOR_DEADLINE'
}
function Get-G03Hash([byte[]]$Data) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Data))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Write-G03NewPrivateFile([string]$Path, [byte[]]$Bytes) {
    $file = New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $file.Write($Bytes,0,$Bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
function Get-G03PublicationSnapshot($Job) {
    Assert-G03Deadline $Job
    Assert-G03 ($script:Config.writesEnabled -eq $true) 'WRITE_DISABLED'
    Assert-G03 ([IO.Path]::GetExtension($Job.source).ToLowerInvariant() -in @('.pdf','.docx','.xlsx','.txt','.csv','.md')) 'SERVER_FORMAT_NOT_READABLE'
    $guards = $null; $stream = $null; $sha = $null
    try {
        $guards = Lock-G03PublishParents $Job.source
        $parent = [IO.Path]::GetDirectoryName($Job.source)
        # An inaccessible directory is an error, never proof of an absent file.
        $entries = @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop | Select-Object -First 5001)
        Assert-G03 ($entries.Count -le 5000) 'DIRECTORY_LIMIT'
        $found = @($entries | Where-Object { $_.FullName -ieq $Job.source })
        Assert-G03 ($found.Count -le 1) 'PATH_DENIED'
        if ($found.Count -eq 0) {
            return @{ok=$true;checkedAt=[DateTime]::UtcNow.ToString('o');source=$Job.source;
                exists=$false;size=$null;sha256=$null;modifiedAt=$null}
        }
        $item = Get-G03SafeItem $Job.source
        Assert-G03 (-not $item.PSIsContainer -and $item.Length -le 16MB) 'SERVER_COPY_LIMIT'
        $stream = Open-G03SnapshotStream $Job.source
        Assert-G03 ($stream.Length -le 16MB) 'SERVER_COPY_LIMIT'
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
        $after = Get-G03SafeItem $Job.source
        Assert-G03Deadline $Job
        return @{ok=$true;checkedAt=[DateTime]::UtcNow.ToString('o');source=$Job.source;
            exists=$true;size=$stream.Length;sha256=$hash;modifiedAt=$after.LastWriteTimeUtc.ToString('o')}
    } finally {
        if ($sha) { $sha.Dispose() }; if ($stream) { $stream.Dispose() }
        if ($guards) { foreach ($guard in $guards) { $guard.Dispose() } }
    }
}
function Write-G03Event([string]$Directory, [string]$Name, $Value) {
    # A half-written receipt must never look like a completed operation. Rename
    # only our private new journal entry, never a customer file. Leftover .pending
    # entries cause quarantine; no automatic cleanup or speculative recovery.
    $target = [IO.Path]::Combine($Directory,$Name)
    $pending = $target + '.pending'
    Write-G03NewPrivateFile $pending ([Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 8 -Compress)))
    [IO.File]::Move($pending,$target)
}
function Get-G03JournalStatus([string]$Directory) {
    try {
        Assert-G03 (@(Get-ChildItem -LiteralPath $Directory -Filter '*.pending').Count -eq 0) 'WRITE_QUARANTINED'
        $intent = [IO.File]::ReadAllText([IO.Path]::Combine($Directory,'intent.json')) | ConvertFrom-Json
        $events = @('committed','rejected','restored') | Where-Object { [IO.File]::Exists([IO.Path]::Combine($Directory,$_+'.json')) }
        Assert-G03 (@($events).Count -eq 1) 'WRITE_QUARANTINED'
        $status = @($events)[0]
        $event = [IO.File]::ReadAllText([IO.Path]::Combine($Directory,$status+'.json')) | ConvertFrom-Json
        if ($status -eq 'committed') {
            Assert-G03 ($event.ok -eq $true -and $event.status -ceq 'committed' -and
                $event.operationId -ceq $intent.operationId -and $event.source -ceq $intent.source -and
                $event.sha256 -ceq $intent.sha256 -and $event.previousSha256 -ceq $intent.expectedSha256) 'WRITE_QUARANTINED'
            Assert-G03 (($intent.operation -eq 'create' -and $null -eq $event.backupId) -or
                ($intent.operation -eq 'replace' -and $event.backupId -ceq $intent.operationId)) 'WRITE_QUARANTINED'
        } elseif ($status -eq 'restored') {
            Assert-G03 ($intent.operation -eq 'replace' -and $event.sha256 -ceq $intent.expectedSha256) 'WRITE_QUARANTINED'
        } else { Assert-G03 ($event.status -ceq 'rejected') 'WRITE_QUARANTINED' }
        return $status
    } catch { throw 'WRITE_QUARANTINED' }
}
function Get-G03PublicationReceipt($Job) {
    # Read only the private operation journal. Never open a customer document,
    # create an operation, or retry a write while reconciling a lost response.
    Assert-G03 ($script:Config.writesEnabled -eq $true) 'WRITE_DISABLED'
    Assert-G03 ($Job.writeOperation -in @('create','replace')) 'INVALID_REQUEST'
    foreach ($id in @($Job.operationId,$Job.actorId,$Job.projectId)) {
        Assert-G03 ($id -cmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') 'INVALID_REQUEST'
    }
    Assert-G03 ($Job.sha256 -cmatch '^[a-f0-9]{64}$') 'INVALID_REQUEST'
    Assert-G03 (($Job.writeOperation -eq 'create' -and $null -eq $Job.expectedSha256) -or
        ($Job.writeOperation -eq 'replace' -and $Job.expectedSha256 -cmatch '^[a-f0-9]{64}$')) 'INVALID_REQUEST'
    $directory = [IO.Path]::Combine($script:Config.writeStateDirectory,$Job.operationId)
    $status = 'not_found'; $backupId = $null
    Assert-G03 (-not [IO.File]::Exists($directory)) 'WRITE_QUARANTINED'
    if ([IO.Directory]::Exists($directory)) {
        Assert-G03 (-not ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'WRITE_QUARANTINED'
        try { $intent = [IO.File]::ReadAllText([IO.Path]::Combine($directory,'intent.json')) | ConvertFrom-Json }
        catch { throw 'WRITE_QUARANTINED' }
        $binding = @{operation=$Job.writeOperation;operationId=$Job.operationId;source=$Job.source;
            sha256=$Job.sha256;expectedSha256=$Job.expectedSha256;actorId=$Job.actorId;projectId=$Job.projectId}
        foreach ($key in $binding.Keys) { Assert-G03 ($intent.$key -ceq $binding[$key]) 'WRITE_OPERATION_CONFLICT' }
        $status = Get-G03JournalStatus $directory
        if ($Job.writeOperation -eq 'replace' -and $status -in @('committed','restored')) {
            $backup = $null; $memory = $null
            try {
                $backup = New-Object IO.FileStream([IO.Path]::Combine($directory,'previous.bin'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
                Assert-G03 ($backup.Length -le 16MB) 'WRITE_QUARANTINED'
                $memory = New-Object IO.MemoryStream
                $backup.CopyTo($memory)
                Assert-G03 ((Get-G03Hash $memory.ToArray()) -ceq $Job.expectedSha256) 'WRITE_QUARANTINED'
            } catch { throw 'WRITE_QUARANTINED' }
            finally { if ($memory) { $memory.Dispose() }; if ($backup) { $backup.Dispose() } }
            $backupId = $Job.operationId
        }
    }
    return @{ok=$true;checkedAt=[DateTime]::UtcNow.ToString('o');operationId=$Job.operationId;
        source=$Job.source;sha256=$Job.sha256;previousSha256=$Job.expectedSha256;backupId=$backupId;status=$status}
}
function Invoke-G03Publish($Job) {
    Assert-G03Deadline $Job
    Assert-G03 ($script:Config.writesEnabled -eq $true) 'WRITE_DISABLED'
    Assert-G03 ($Job.operation -in @('create','replace')) 'WRITE_DISABLED'
    Assert-G03 ($Job.operationId -cmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') 'INVALID_REQUEST'
    foreach ($id in @($Job.actorId,$Job.projectId)) {
        Assert-G03 ($id -cmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') 'INVALID_REQUEST'
    }
    Assert-G03 ([IO.Path]::GetExtension($Job.source).ToLowerInvariant() -in @('.pdf','.docx','.xlsx','.txt','.csv','.md')) 'SERVER_FORMAT_NOT_READABLE'
    Assert-G03 ($Job.sha256 -cmatch '^[a-f0-9]{64}$') 'INVALID_REQUEST'
    Assert-G03 (($Job.operation -eq 'create' -and $null -eq $Job.expectedSha256) -or
        ($Job.operation -eq 'replace' -and $Job.expectedSha256 -cmatch '^[a-f0-9]{64}$')) 'INVALID_REQUEST'
    Assert-G03 ($Job.base64.Length -le 22369624) 'SERVER_COPY_LIMIT'
    $newBytes = [Convert]::FromBase64String($Job.base64)
    Assert-G03 ($newBytes.Length -gt 0 -and $newBytes.Length -le 16MB -and (Get-G03Hash $newBytes) -ceq $Job.sha256) 'SERVER_COPY_LIMIT'
    $state = $script:Config.writeStateDirectory
    $operationDirectory = [IO.Path]::Combine($state,$Job.operationId)
    $binding = @{operation=$Job.operation;operationId=$Job.operationId;source=$Job.source;sha256=$Job.sha256;
        expectedSha256=$Job.expectedSha256;actorId=$Job.actorId;projectId=$Job.projectId}
    if ([IO.Directory]::Exists($operationDirectory)) {
        $saved = [IO.File]::ReadAllText([IO.Path]::Combine($operationDirectory,'intent.json')) | ConvertFrom-Json
        foreach ($key in $binding.Keys) { Assert-G03 ($saved.$key -ceq $binding[$key]) 'WRITE_OPERATION_CONFLICT' }
        Assert-G03 ((Get-G03JournalStatus $operationDirectory) -ceq 'committed') 'WRITE_QUARANTINED'
        $receiptPath = [IO.Path]::Combine($operationDirectory,'committed.json')
        $receipt = [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
        # This is the original durable receipt, never a second write.
        $receipt.status = 'already_committed'; $receipt.checkedAt = [DateTime]::UtcNow.ToString('o')
        return $receipt
    }
    # Uncertain writes anywhere in this connector require explicit recovery.
    foreach ($dir in [IO.Directory]::EnumerateDirectories($state)) {
        $null = Get-G03JournalStatus $dir
    }
    # No automatic pruning of versions. Stop before exhausting the volume.
    $used = 0L; $count = 0
    foreach ($f in Get-ChildItem -LiteralPath $state -File -Recurse) {
        $used += $f.Length; $count++
        Assert-G03 ($used -lt 512MB -and $count -lt 10000) 'WRITE_CAPACITY'
    }
    $volume = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($state))
    Assert-G03 ($volume.AvailableFreeSpace -gt 1GB) 'WRITE_CAPACITY'
    $guards = $null; $stream = $null; $transaction = $null; $oldBytes = $null
    $started = $false; $commitStarted = $false
    try {
        # Parent directories remain pinned against rename/reparse replacement.
        $guards = Lock-G03PublishParents $Job.source
        if ($Job.operation -eq 'replace') {
            $before = Get-G03SafeItem $Job.source
            Assert-G03 (-not $before.PSIsContainer -and $before.Length -le 16MB) 'SERVER_COPY_LIMIT'
        }
        $null = [IO.Directory]::CreateDirectory($operationDirectory)
        Write-G03Event $operationDirectory 'intent.json' $binding
        $started = $true
        # Exclusive transacted handle: content is not exposed before commit and
        # a process crash rolls back through Windows. Never fall back to an
        # ordinary in-place write on an unsupported or busy volume.
        $transaction = New-G03FileTransaction
        $stream = $transaction.Open($Job.source,($Job.operation -eq 'create'))
        if ($Job.operation -eq 'replace') {
            Assert-G03 ($stream.Length -le 16MB) 'SERVER_COPY_LIMIT'
            $memory = New-Object IO.MemoryStream
            try { $stream.CopyTo($memory); $oldBytes = $memory.ToArray() } finally { $memory.Dispose() }
            Assert-G03 ((Get-G03Hash $oldBytes) -ceq $Job.expectedSha256) 'WRITE_CONFLICT'
            Write-G03NewPrivateFile ([IO.Path]::Combine($operationDirectory,'previous.bin')) $oldBytes
            Assert-G03 ((Get-G03Hash ([IO.File]::ReadAllBytes([IO.Path]::Combine($operationDirectory,'previous.bin')))) -ceq $Job.expectedSha256) 'WRITE_QUARANTINED'
        }
        Assert-G03Deadline $Job
        Write-G03Event $operationDirectory 'prepared.json' @{sha256=$Job.sha256;backupSha256=$Job.expectedSha256}
        $null = $stream.Seek(0,[IO.SeekOrigin]::Begin)
        $stream.Write($newBytes,0,$newBytes.Length); $stream.SetLength($newBytes.Length); $stream.Flush($true)
        $null = $stream.Seek(0,[IO.SeekOrigin]::Begin)
        $check = New-Object IO.MemoryStream
        try { $stream.CopyTo($check); Assert-G03 ((Get-G03Hash $check.ToArray()) -ceq $Job.sha256) 'WRITE_QUARANTINED' }
        finally { $check.Dispose() }
        $stream.Dispose(); $stream = $null
        Assert-G03Deadline $Job
        $commitStarted = $true
        $transaction.Commit()
        $receipt = @{ok=$true;checkedAt=[DateTime]::UtcNow.ToString('o');operationId=$Job.operationId;
            source=$Job.source;sha256=$Job.sha256;previousSha256=$Job.expectedSha256;
            backupId=$(if($Job.operation -eq 'replace'){$Job.operationId}else{$null});status='committed'}
        Write-G03Event $operationDirectory 'committed.json' $receipt
        return $receipt
    } catch {
        $code = $_.Exception.Message
        # A commit or receipt failure is uncertain. Never compensate by writing
        # over a subsequent employee edit; preserve backup + journal for review.
        if ($commitStarted) { throw 'WRITE_QUARANTINED' }
        if ($stream) { $stream.Dispose(); $stream = $null }
        if ($transaction) {
            try { $transaction.Rollback() } catch { throw 'WRITE_QUARANTINED' }
        }
        if ($started) { Write-G03Event $operationDirectory 'rejected.json' @{status='rejected'} }
        if ($code -in @('WRITE_CONFLICT','WRITE_QUARANTINED','WRITE_ATOMIC_UNAVAILABLE','SERVER_COPY_LIMIT','CONNECTOR_DEADLINE')) { throw $code }
        throw 'WRITE_SOURCE_BUSY'
    } finally {
        if ($stream) { $stream.Dispose() }
        if ($transaction) { $transaction.Dispose() }
        if ($guards) { foreach ($guard in $guards) { $guard.Dispose() } }
    }
}
