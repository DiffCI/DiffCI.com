param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$RunLibraryTests
)

$ErrorActionPreference = 'Stop'
$packetDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $packetDirectory) {
    throw 'Use a new output directory so previous evidence is preserved.'
}
New-Item -ItemType Directory -Path $packetDirectory | Out-Null
$repoDirectory = Join-Path $packetDirectory 'remeda'
git clone --depth 80 https://github.com/remeda/remeda.git $repoDirectory
if ($LASTEXITCODE -ne 0) { throw 'Clone failed.' }

$cases = @(
    @{ label='source'; base='5d7dc5fc95b6a4c7ab21278f3ca85631d31bddae'; head='b9ec4b0ac5ba86f2f687bae6e92d318db02eea24' },
    @{ label='broad'; base='7f134659d0a03a4e77c631bf5fe0485e9359b092'; head='09afe15535be715c13c437a1d4d06b08ba4cdbcd' },
    @{ label='dependency'; base='e8292ddf03f8a334cf8b048983d518f89fe6be97'; head='9955bb0eca98cc5d1bbb17dc4314dd38a10a28d5' }
)
Push-Location $repoDirectory
$priorCI = $env:CI
try {
    $env:CI = 'true'
    foreach ($case in $cases) {
        git fetch origin $case.base $case.head
        if ($LASTEXITCODE -ne 0) { throw 'Fetching the frozen revisions failed.' }
        git checkout --detach $case.head
        if ($LASTEXITCODE -ne 0) { throw 'Checkout failed.' }
        npm ci --ignore-scripts --no-audit --no-fund *> (Join-Path $packetDirectory "$($case.label)-install.log")
        if ($LASTEXITCODE -ne 0) { throw 'Installing the frozen lockfile failed.' }
        $report = Join-Path $packetDirectory "$($case.label).json"
        npx --yes '@diffci.com/diffci@0.3.1' check --base $case.base --head $case.head --out $report --no-send
        if ($LASTEXITCODE -ne 0) { throw 'DiffCI check failed; inspect the report.' }
        $observation = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json
        if ($observation.status -ne 'OBSERVED') { throw 'Analysis did not complete.' }
        if ($RunLibraryTests) {
            $before = @(git status --porcelain)
            $clock = [Diagnostics.Stopwatch]::StartNew()
            npm --workspace packages/remeda test -- --run *> (Join-Path $packetDirectory "$($case.label)-full-tests.log")
            $testExit = $LASTEXITCODE
            $clock.Stop()
            @{
                command = 'npm --workspace packages/remeda test -- --run'
                head = (git rev-parse HEAD)
                wallMs = $clock.ElapsedMilliseconds
                exitCode = $testExit
                gitStatusBefore = $before
                gitStatusAfter = @(git status --porcelain)
            } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packetDirectory "$($case.label)-baseline.json")
            Write-Output "$($case.label): library test exit $testExit; elapsed $($clock.ElapsedMilliseconds) ms"
        }
    }
} finally {
    $env:CI = $priorCI
    Pop-Location
}
