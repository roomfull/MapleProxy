$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $operation = [Console]::In.ReadLine()
    $encoded = [Console]::In.ReadLine()
    if ($operation -notin @('encrypt', 'decrypt') -or $encoded.Length -gt 4194304) { throw 'Invalid protocol' }
    $bytes = [Convert]::FromBase64String($encoded)
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($operation -eq 'encrypt') {
        $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
    } else {
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($result))
    exit 0
} catch {
    # Never emit exception text, plaintext, or ciphertext.
    exit 1
}
