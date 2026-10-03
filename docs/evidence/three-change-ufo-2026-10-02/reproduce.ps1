param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new output directory to preserve earlier evidence.' }
New-Item -ItemType Directory -Path $output | Out-Null
$repo = Join-Path $output 'ufo'
git -c core.autocrlf=false clone https://github.com/unjs/ufo.git $repo
if ($LASTEXITCODE -ne 0) { throw 'Clone failed.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$priorCI = $env:CI
Push-Location $repo
try {
    $env:CI = 'true'
    foreach ($case in $manifest.cases) {
        git checkout --detach $case.head
        if ($LASTEXITCODE -ne 0) { throw 'Checkout failed.' }
        # Corepack uses packageManager from this frozen checkout.
        corepack pnpm install --frozen-lockfile --ignore-scripts *> (Join-Path $output "$($case.label)-install.log")
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        $observation = Join-Path $output "$($case.label).json"
        npx --yes '@diffci.com/diffci@0.3.1' check --base $case.base --head $case.head --out $observation --no-send --timeout-ms 120000
        # check can fail its execution arm while still producing a usable observation.
        if (-not (Test-Path -LiteralPath $observation)) { throw 'No observation was produced.' }
        $report = Get-Content -LiteralPath $observation -Raw | ConvertFrom-Json
        if ($report.status -ne 'OBSERVED') { throw 'Analysis did not complete.' }
        corepack pnpm exec vitest run --typecheck *> (Join-Path $output "$($case.label)-full-with-types.log")
        if ($LASTEXITCODE -ne 0) { throw 'Full tests failed; retain the output and do not claim savings.' }
        if ($report.result.mode -eq 'SELECTIVE') {
            npx --yes '@diffci.com/diffci@0.3.1' verify-savings --repo . --full 'pnpm exec vitest run' --selected-from-report $observation --out (Join-Path $output "$($case.label)-runtime.json") --repetitions 3 --cache-state unknown --label "UFO runtime phase $($case.label) change"
            if ($LASTEXITCODE -ne 0) { throw 'Runtime comparison failed; inspect the saved report.' }
        }
    }
} finally {
    $env:CI = $priorCI
    Pop-Location
}

# Install pnpm shims through Corepack before running, so the proposed pnpm exec
# selected command is available too. Never interpret pnpm test versus a bare
# selected runtime command as an equal-scope whole-pipeline comparison.
