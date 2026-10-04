param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new output directory.' }
New-Item -ItemType Directory -Path $output | Out-Null
$repo = Join-Path $output 'immer'
git -c core.autocrlf=false clone https://github.com/immerjs/immer.git $repo
if ($LASTEXITCODE -ne 0) { throw 'Clone failed.' }
$manifest = Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$priorCI = $env:CI
Push-Location $repo
try {
    $env:CI = 'true'
    foreach ($case in $manifest.cases) {
        git checkout --detach $case.head
        if ($LASTEXITCODE -ne 0) { throw 'Checkout failed.' }
        $ErrorActionPreference = 'Continue'
        yarn.cmd install --frozen-lockfile --ignore-scripts --non-interactive --registry https://registry.npmjs.org --network-timeout 15000 *> (Join-Path $output "$($case.label)-install.log")
        $installExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($installExit -ne 0) { throw 'Install failed.' }
        $observation = Join-Path $output "$($case.label).json"
        npx.cmd --yes '@diffci.com/diffci@0.3.1' check --base $case.base --head $case.head --out $observation --no-send --timeout-ms 90000
        if (-not (Test-Path $observation)) { throw 'No observation report.' }
        # Default check compares yarn test (runtime, build, Flow) against runtime
        # alone. Do not claim that unequal-scope comparison as savings.
        yarn.cmd run vitest run --config vitest.config.ts *> (Join-Path $output "$($case.label)-full-runtime.log")
        if ($LASTEXITCODE -ne 0) { throw 'Full runtime baseline failed.' }
        $report = Get-Content $observation -Raw | ConvertFrom-Json
        if ($report.result.mode -eq 'SELECTIVE') {
            npx.cmd --yes '@diffci.com/diffci@0.3.1' verify-savings --repo . --full 'yarn run vitest run --config vitest.config.ts' --selected-from-report $observation --out (Join-Path $output "$($case.label)-runtime.json") --repetitions 3 --cache-state unknown --label "Immer runtime phase $($case.label) change"
            if ($LASTEXITCODE -ne 0) { throw 'Comparison failed.' }
        }
    }
} finally {
    $env:CI = $priorCI
    Pop-Location
}
# Prerequisites: Node 24 and Yarn Classic 1.22.22 available on PATH.
# Saved measurements are Windows runtime phase results, not whole CI savings.
