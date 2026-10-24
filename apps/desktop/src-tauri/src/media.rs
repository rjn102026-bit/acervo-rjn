use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn media_command(tool: &Path) -> Command {
    let mut command = Command::new(tool);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // FFmpeg e FFprobe são aplicativos de console; evite janelas piscando no desktop.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

const VIDEO: &[&str] = &["mp4", "mov", "mxf", "avi", "mts", "m2ts", "mpg", "mpeg"];
const IMAGE: &[&str] = &[
    "jpg", "jpeg", "png", "tif", "tiff", "dng", "heic", "cr2", "nef",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GpsCoordinates {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub kind: String,
    pub duration_seconds: Option<f64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub video_codec: Option<String>,
    pub recorded_at: Option<String>,
    #[serde(default)]
    pub gps: Option<GpsCoordinates>,
    #[serde(default)]
    pub location_label: Option<String>,
    #[serde(default)]
    pub metadata_version: u8,
}

pub const METADATA_VERSION: u8 = 2;

pub fn valid_gps(latitude: f64, longitude: f64) -> Option<GpsCoordinates> {
    (latitude.is_finite() && longitude.is_finite() && latitude.abs() <= 90.0 && longitude.abs() <= 180.0)
        .then_some(GpsCoordinates { latitude, longitude })
}

fn gps_from_tag(raw: &str) -> Option<GpsCoordinates> {
    let value = raw.trim().trim_end_matches('/');
    if let Some((lat, lon)) = value.split_once(',') {
        return valid_gps(lat.trim().parse().ok()?, lon.trim().parse().ok()?);
    }
    if !value.starts_with(['+', '-']) { return None; }
    let lon_start = value[1..].find(['+', '-'])? + 1;
    let lon_end = value[lon_start + 1..].find(['+', '-'])
        .map(|offset| lon_start + 1 + offset).unwrap_or(value.len());
    valid_gps(value[..lon_start].parse().ok()?, value[lon_start..lon_end].parse().ok()?)
}

fn tag_value<'a>(tags: &'a Value, names: &[&str]) -> Option<&'a str> {
    let object = tags.as_object()?;
    object.iter().find_map(|(key, value)| {
        names.iter().any(|name| key.eq_ignore_ascii_case(name))
            .then(|| value.as_str()).flatten()
    })
}

pub fn kind_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if VIDEO.contains(&extension.as_str()) {
        "video"
    } else if IMAGE.contains(&extension.as_str()) {
        "image"
    } else {
        "sidecar"
    }
}

fn executable(directory: Option<&str>, name: &str) -> Result<PathBuf, String> {
    if let Some(directory) = directory.filter(|value| !value.trim().is_empty()) {
        let name = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        let path = Path::new(directory).join(name);
        if !path.is_file() {
            return Err(format!(
                "{} não encontrado na pasta FFmpeg selecionada",
                path.display()
            ));
        }
        Ok(path)
    } else {
        if cfg!(windows) {
            let file_name = format!("{name}.exe");
            let chocolatey = std::env::var_os("ChocolateyInstall")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("ProgramData")
                        .map(|path| PathBuf::from(path).join("chocolatey"))
                });
            if let Some(directory) = chocolatey {
                let path = directory.join("bin").join(file_name);
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
        Ok(PathBuf::from(name))
    }
}

pub fn parse_probe(value: &Value, kind: &str) -> MediaMetadata {
    let stream = value["streams"].as_array().and_then(|streams| {
        streams
            .iter()
            .find(|stream| stream["codec_type"] == "video")
    });
    let duration = value["format"]["duration"]
        .as_str()
        .or_else(|| stream.and_then(|item| item["duration"].as_str()))
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0);
    let recorded_at = value["format"]["tags"]["creation_time"]
        .as_str()
        .or_else(|| stream.and_then(|item| item["tags"]["creation_time"].as_str()))
        .map(str::to_owned);
    let format_tags = &value["format"]["tags"];
    let stream_tags = stream.map(|item| &item["tags"]);
    let gps = [format_tags, stream_tags.unwrap_or(&Value::Null)].iter()
        .find_map(|tags| tag_value(tags, &["location", "location-eng", "com.apple.quicktime.location.ISO6709", "GPSCoordinates"])
            .and_then(gps_from_tag)
            .or_else(|| {
                let latitude = tag_value(tags, &["GPSLatitude", "latitude"])?.trim().parse::<f64>().ok()?;
                let longitude = tag_value(tags, &["GPSLongitude", "longitude"])?.trim().parse::<f64>().ok()?;
                valid_gps(latitude, longitude)
            }));
    let location_label = [format_tags, stream_tags.unwrap_or(&Value::Null)].iter()
        .find_map(|tags| tag_value(tags, &["location_name", "com.apple.quicktime.location.name", "location"])
            .filter(|text| !text.trim().is_empty() && text.len() <= 120 && gps_from_tag(text).is_none())
            .map(str::to_owned));
    MediaMetadata {
        kind: kind.to_string(),
        duration_seconds: duration,
        width: stream.and_then(|item| item["width"].as_u64()),
        height: stream.and_then(|item| item["height"].as_u64()),
        video_codec: stream
            .and_then(|item| item["codec_name"].as_str())
            .map(str::to_owned),
        recorded_at,
        gps,
        location_label,
        metadata_version: METADATA_VERSION,
    }
}

pub fn probe(
    path: &Path,
    kind: &str,
    tools_directory: Option<&str>,
) -> Result<MediaMetadata, String> {
    let tool = executable(tools_directory, "ffprobe")?;
    let output = media_command(&tool)
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|error| format!("FFprobe indisponível: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "FFprobe falhou: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Resposta inválida do FFprobe: {error}"))?;
    Ok(parse_probe(&value, kind))
}

pub fn make_thumbnail(
    path: &Path,
    thumbnails_dir: &Path,
    asset_id: &str,
    tools_directory: Option<&str>,
) -> Result<String, String> {
    let tool = executable(tools_directory, "ffmpeg")?;
    fs::create_dir_all(thumbnails_dir).map_err(|error| error.to_string())?;
    let thumbnail = thumbnails_dir.join(format!("{asset_id}.jpg"));
    let partial = thumbnails_dir.join(format!("{asset_id}.partial.jpg"));
    let output = media_command(&tool)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=480:-2:force_original_aspect_ratio=decrease",
            "-q:v",
            "4",
        ])
        .arg(&partial)
        .output()
        .map_err(|error| format!("FFmpeg indisponível: {error}"))?;
    if !output.status.success()
        || fs::metadata(&partial)
            .map(|meta| meta.len() == 0)
            .unwrap_or(true)
    {
        let _ = fs::remove_file(&partial);
        return Err(format!(
            "Miniatura não gerada: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    fs::rename(&partial, &thumbnail).map_err(|error| error.to_string())?;
    Ok(format!("thumbnails/{asset_id}.jpg"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_video_metadata_without_inventing_missing_fields() {
        let value: Value = serde_json::json!({
            "format": { "duration": "12.5", "tags": { "creation_time": "2026-10-10T12:00:00Z" } },
            "streams": [{ "codec_type": "audio" }, { "codec_type": "video", "width": 1920, "height": 1080, "codec_name": "h264" }]
        });
        let result = parse_probe(&value, "video");
        assert_eq!(result.duration_seconds, Some(12.5));
        assert_eq!(result.width, Some(1920));
        assert_eq!(result.video_codec.as_deref(), Some("h264"));
        assert_eq!(result.recorded_at.as_deref(), Some("2026-10-10T12:00:00Z"));
    }

    #[test]
    fn classifies_telemetry_as_sidecar() {
        assert_eq!(kind_for(Path::new("DJI_0001.MP4")), "video");
        assert_eq!(kind_for(Path::new("flight.SRT")), "sidecar");
    }

    #[test]
    fn reads_embedded_gps_without_confusing_coordinates_with_a_place_name() {
        let value = serde_json::json!({"format": {"tags": {"com.apple.quicktime.location.ISO6709": "-20.28950-040.29010+008.0/"}}});
        let metadata = parse_probe(&value, "video");
        assert!((metadata.gps.unwrap().latitude + 20.2895).abs() < 0.00001);
        assert!(metadata.location_label.is_none());
        assert!(gps_from_tag("91, -40").is_none());
    }
}


pub fn make_analysis_frame(path: &Path, directory: &Path, asset_id: &str, index: usize, seconds: f64, max_dimension: u32) -> Result<PathBuf, String> {
    let tool = executable(None, "ffmpeg")?;
    let frame = directory.join(format!("{asset_id}-{index}-{}.jpg", uuid::Uuid::new_v4()));
    let mut command = media_command(&tool);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    if kind_for(path) == "video" { command.args(["-ss", &format!("{seconds:.3}")]); }
    let scale = format!("scale={0}:{0}:force_original_aspect_ratio=decrease", max_dimension.clamp(224, 768));
    let output = command.arg("-i").arg(path)
        .args(["-frames:v", "1", "-vf", &scale, "-q:v", "3"]).arg(&frame)
        .output().map_err(|error| format!("Não foi possível extrair quadro para IA: {error}"))?;
    if !output.status.success() || fs::metadata(&frame).map(|value| value.len() == 0).unwrap_or(true) {
        let _ = fs::remove_file(&frame);
        return Err(format!("Quadro para análise visual não gerado: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(frame)
}

