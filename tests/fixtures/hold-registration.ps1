param([string]$Target, [ValidateSet('Read', 'Exclusive', 'ReadOnly', 'DenyWrite')][string]$Mode)
$ErrorActionPreference = 'Stop'
$resolved = [IO.Path]::GetFullPath($Target)
$testRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build')) + '\'
if (-not $resolved.StartsWith($testRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fault injection must stay in tests/build' }
$stream = $null
$attributes = $null
$originalAcl = $null
try {
    if ($Mode -eq 'DenyWrite') {
        $acl = [IO.Directory]::GetAccessControl($resolved)
        $originalAcl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'Write,Delete,DeleteSubdirectoriesAndFiles', 'ContainerInherit,ObjectInherit', 'None', 'Deny')
        $acl.AddAccessRule($rule)
        [IO.Directory]::SetAccessControl($resolved, $acl)
    } elseif ($Mode -eq 'ReadOnly') {
        $attributes = [IO.File]::GetAttributes($resolved)
        [IO.File]::SetAttributes($resolved, $attributes -bor [IO.FileAttributes]::ReadOnly)
    } else {
        $share = if ($Mode -eq 'Exclusive') { [IO.FileShare]::None } else { [IO.FileShare]::ReadWrite }
        $stream = [IO.File]::Open($resolved, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    }
    [Console]::WriteLine('READY')
    [Console]::ReadLine() | Out-Null
} finally {
    if ($stream) { $stream.Dispose() }
    if ($null -ne $attributes) { [IO.File]::SetAttributes($resolved, $attributes) }
    if ($originalAcl) {
        $restore = New-Object Security.AccessControl.DirectorySecurity
        $restore.SetSecurityDescriptorSddlForm($originalAcl)
        [IO.Directory]::SetAccessControl($resolved, $restore)
    }
}
