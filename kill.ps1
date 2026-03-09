Get-Process | Where-Object { $_.ProcessName -match 'Bandwidth|BandwidthGovernor' } | Stop-Process -Force -ErrorAction SilentlyContinue
