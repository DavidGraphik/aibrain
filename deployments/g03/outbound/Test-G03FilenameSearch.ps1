#requires -Version 5.1
# Offline Windows/NTFS fixture test. Never loads installation configuration or
# tokens, polls a service, or touches the customer's document roots.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_REQUIRED_NOT_ACCEPTED_ON_MAC_OR_LINUX'}
$tokens=$null; $errors=$null
$agent=Join-Path $PSScriptRoot 'G03Connector.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($agent,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'CONNECTOR_SYNTAX_INVALID'}
$functions=@('Assert-G03','Test-G03Segment','Test-G03Within','Test-G03Allowed','Assert-G03Keys','Get-G03SafeItem','Get-G03Entry')
foreach($node in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){
    if($node.Name -in $functions){. ([ScriptBlock]::Create($node.Extent.Text))}
}
$addType=$ast.Find({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-Type'},$true)
if(-not $addType){throw 'HANDLE_VALIDATOR_MISSING'}
. ([ScriptBlock]::Create($addType.Parent.Extent.Text))
function Assert-G03Protected($Path,$ReaderSid) {} # Fixture-only: deployment ACL qualification is a separate gate.
$script:TestActive=$true
function Invoke-G03Https($Action,$Body,$TimeoutMs){if($Action -cne 'poll' -or -not $Body.active){throw 'NETWORK_FORBIDDEN'};return @{active=$script:TestActive}}
function Need($Value,$Code){if(-not $Value){throw $Code}}
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('aibrain-search-fixture-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $temporary
$temporary=(Get-Item -LiteralPath $temporary).FullName
$root=Join-Path $temporary 'Company';$outside=Join-Path $temporary 'Outside'
try{
    $null=New-Item -ItemType Directory -Path $root,$outside,(Join-Path $root 'One'),(Join-Path $root 'Two')
    [IO.File]::WriteAllText((Join-Path $root 'One\00512-7134.A4.pdf'),'synthetic')
    [IO.File]::WriteAllText((Join-Path $root 'Two\00512 7134 B.pdf'),'synthetic')
    [IO.File]::WriteAllText((Join-Path $root '005127134 C.pdf'),'synthetic')
    [IO.File]::WriteAllText((Join-Path $root 'a[0].txt'),'synthetic')
    [IO.File]::WriteAllText((Join-Path $root 'a0.txt'),'synthetic')
    [IO.File]::WriteAllText((Join-Path $root 'tokens.txt'),'synthetic-excluded')
    [IO.File]::WriteAllText((Join-Path $outside 'outside-marker.txt'),'synthetic-excluded')
    $null=New-Item -ItemType Junction -Path (Join-Path $root 'OutsideLink') -Target $outside
    $script:Config=[pscustomobject]@{installationId='g03-fixture';connectionId='g03';policyHash=('a'*64);
        accountSid='fixture';expectedComputer='fixture';baseUrl='https://example.test/g03-files/v1';tokenFile='not-read';roots=@($root)}
    $identity=[pscustomobject]@{User=[pscustomobject]@{Value='fixture'}}
    $ConfigPath=Join-Path $temporary 'fixture.json'
    [IO.File]::WriteAllText($ConfigPath,($script:Config | ConvertTo-Json -Depth 5))
    . (Join-Path $PSScriptRoot 'G03FilenameSearch.ps1')
    function New-Job($Needle,$Cursor=$null,$Binding=('b'*64)){
        return [pscustomobject]@{schemaVersion=2;installationId='g03-fixture';connectionId='g03';policyHash=('a'*64);
            jobId=[Guid]::NewGuid().ToString();budgetMs=4000;operation='filename_search';roots=@($root);
            needle=$Needle;cursor=$Cursor;binding=$Binding;limit=1}
    }
    function Run-Job($Job){return Invoke-G03FilenameSearch $Job ([Diagnostics.Stopwatch]::StartNew()) ([Guid]::NewGuid().ToString('N'))}
    $first=Run-Job (New-Job '005127134');Need $first.ok 'FIRST_PAGE_FAILED'
    $names=New-Object 'Collections.Generic.List[string]'
    foreach($row in $first.entries){$names.Add($row.source)}
    $cursor=$first.nextCursor;Need ($null -ne $cursor) 'CONTINUATION_MISSING'
    $resumed=Run-Job (New-Job $null $cursor);Need $resumed.ok 'RESUME_FAILED'
    $replay=Run-Job (New-Job $null $cursor)
    Need (($resumed.entries | ConvertTo-Json -Compress) -ceq ($replay.entries | ConvertTo-Json -Compress)) 'REPLAY_CHANGED_PAGE'
    Need ($resumed.nextCursor -ceq $replay.nextCursor) 'REPLAY_ADVANCED_CURSOR'
    foreach($row in $resumed.entries){$names.Add($row.source)}
    $denied=Run-Job (New-Job $null $cursor ('c'*64));Need ($denied.error -ceq 'SEARCH_CURSOR_EXPIRED_OR_DENIED') 'FOREIGN_USER_ACCEPTED'
    $cursor=$resumed.nextCursor;$iterations=0
    while($cursor){
        $iterations++;Need ($iterations -le 16) 'UNBOUNDED_CONTINUATION'
        $page=Run-Job (New-Job $null $cursor);Need $page.ok 'PAGE_FAILED'
        foreach($row in $page.entries){$names.Add($row.source)}
        $cursor=$page.nextCursor
    }
    Need ($names.Count -eq 3 -and @($names | Sort-Object -Unique).Count -eq 3) 'MATCHES_LOST_OR_DUPLICATED'
    Need (-not $page.coverage.snapshot -and $page.coverage.complete) 'FALSE_COVERAGE'
    foreach($needle in @('outside-marker','tokens')){
        $job=New-Job $needle;$job.limit=50;$page=Run-Job $job
        Need ($page.ok -and $page.entries.Count -eq 0 -and -not $page.limited) 'EXCLUDED_SOURCE_LEAK'
    }
    $literal=Run-Job (New-Job 'a[0]');Need ($literal.ok -and $literal.entries.Count -eq 1 -and $literal.entries[0].name -ceq 'a[0].txt') 'REGEX_WAS_INTERPRETED'
    Need (Test-G03Filename ('cafe'+[char]0x301+'.pdf') ('caf'+[char]0xe9)) 'UNICODE_NORMALIZATION_FAILED'
    Need (-not (Test-G03Segment ('c'+[char]0xf2+'pies'))) 'SENSITIVE_UNICODE_FOLDER_ALLOWED'
    $before=$script:G03NamePages.Count;$script:TestActive=$false
    $cancelled=Run-Job (New-Job '005127134');Need ($cancelled.error -ceq 'SEARCH_CANCELLED') 'CANCEL_IGNORED'
    Need ($before -eq $script:G03NamePages.Count) 'INITIAL_CANCEL_LEAKED_CURSOR'
    $script:TestActive=$true
    $revoked=$script:Config | ConvertTo-Json -Depth 5 | ConvertFrom-Json;$revoked.roots=@($outside)
    [IO.File]::WriteAllText($ConfigPath,($revoked | ConvertTo-Json -Depth 5))
    $denied=Run-Job (New-Job $null $first.nextCursor);Need ($denied.error -ceq 'SEARCH_POLICY_CHANGED') 'SOURCE_REVOCATION_IGNORED'
    Write-Output 'OFFLINE_WINDOWS_FILENAME_SEARCH_FIXTURES_PASS: not installation or UI acceptance.'
}finally{
    if(Get-Variable G03NamePages -Scope Script -ErrorAction SilentlyContinue){foreach($page in $script:G03NamePages.Values){Close-G03NameState $page.State}}
    # Remove the junction itself first; never recurse through its target.
    $link=Join-Path $root 'OutsideLink';if(Test-Path -LiteralPath $link){[IO.Directory]::Delete($link)}
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
