use crate::{ingest::EXTENSIONS, media};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{Duration, Instant};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
pub struct SourceDevice {
    pub path: String,
    pub label: String,
    pub capacity_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct SourceInventory {
    pub path: String,
    pub videos: u64,
    pub images: u64,
    pub sidecars: u64,
    pub total_bytes: u64,
    pub ignored_files: u64,
    pub unreadable_entries: u64,
    pub partial: bool,
}

// Enumerate Windows volumes without touching or writing media files. Get-Disk
// includes USB devices that Windows exposes as fixed disks instead of removable.
#[cfg(windows)]
pub fn list_source_devices_impl() -> Result<Vec<SourceDevice>, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 2 OR DriveType = 3')
$usbLetters = @{}
try {
    Get-Disk | Where-Object { $_.BusType -eq 'USB' } | Get-Partition | ForEach-Object {
        if ($_.DriveLetter) { $usbLetters[([string]$_.DriveLetter + ':')] = $true }
    }
} catch { }
$result = @($volumes | Where-Object { $_.DriveType -eq 2 -or $usbLetters.ContainsKey($_.DeviceID) } | ForEach-Object {
    [PSCustomObject]@{
        path = $_.DeviceID + '\'
        label = $(if ($_.VolumeName) { $_.VolumeName } else { 'Dispositivo USB' })
        capacity_bytes = [uint64]$_.Size
        free_bytes = [uint64]$_.FreeSpace
    }
})
ConvertTo-Json -InputObject $result -Compress
"#;
    let powershell = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .ok_or("Não foi possível localizar o Windows para detectar dispositivos.")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = Command::new(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|error| format!("Não foi possível detectar dispositivos: {error}"))?;
    if !output.status.success() {
        return Err("Não foi possível consultar os dispositivos USB. Escolha a pasta de origem manualmente.".into());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Não foi possível ler a lista de dispositivos: {error}"))
}

#[cfg(not(windows))]
pub fn list_source_devices_impl() -> Result<Vec<SourceDevice>, String> {
    Ok(Vec::new())
}

pub fn inspect_source_impl(source: &str) -> Result<SourceInventory, String> {
    let input = source.trim();
    if input.is_empty() {
        return Err("Escolha uma pasta ou dispositivo de origem.".into());
    }
    let root = std::fs::canonicalize(Path::new(input))
        .map_err(|error| format!("Origem indisponível. Confira se o dispositivo está conectado: {error}"))?;
    if !root.is_dir() {
        return Err("A origem precisa ser uma pasta existente.".into());
    }
    // Fail explicitly for an unreadable root instead of reporting an empty card.
    std::fs::read_dir(&root).map_err(|error| format!("Não foi possível ler a origem: {error}"))?;
    let mut inventory = SourceInventory {
        path: input.to_string(), videos: 0, images: 0, sidecars: 0,
        total_bytes: 0, ignored_files: 0, unreadable_entries: 0, partial: false,
    };
    let start = Instant::now();
    let entries = WalkDir::new(&root).follow_links(false).into_iter().filter_entry(|entry| {
        // Windows service folders are not camera media and may be inaccessible.
        !entry.file_type().is_dir() || !matches!(entry.file_name().to_str(), Some("System Volume Information" | "$RECYCLE.BIN"))
    });
    for (count, entry) in entries.enumerate() {
        // Large or damaged sources must not leave the UI waiting indefinitely.
        if count >= 200_000 || start.elapsed() > Duration::from_secs(20) {
            inventory.partial = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => { inventory.unreadable_entries += 1; continue; }
        };
        if !entry.file_type().is_file() { continue; }
        let extension = entry.path().extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        if !EXTENSIONS.contains(&extension.as_str()) {
            inventory.ignored_files += 1;
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => { inventory.unreadable_entries += 1; continue; }
        };
        match media::kind_for(entry.path()) {
            "video" => inventory.videos += 1,
            "image" => inventory.images += 1,
            _ => inventory.sidecars += 1,
        }
        inventory.total_bytes = inventory.total_bytes.saturating_add(metadata.len());
    }
    Ok(inventory)
}
