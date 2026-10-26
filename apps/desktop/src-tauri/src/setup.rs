use crate::{ai, media};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

#[derive(Serialize)]
pub struct InstallationStatus {
    pub tools: Vec<media::ToolStatus>,
    pub ai: ai::OllamaStatus,
}

pub fn status() -> InstallationStatus {
    InstallationStatus {
        tools: vec![media::tool_status("ffmpeg"), media::tool_status("ffprobe")],
        ai: ai::status_impl(),
    }
}

#[derive(Clone, Serialize)]
pub struct ModelProgress {
    pub status: String,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

pub fn download_model(progress: impl Fn(ModelProgress)) -> Result<ai::OllamaStatus, String> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(7200))
        .build().map_err(|error| error.to_string())?;
    let response = client.post("http://127.0.0.1:11434/api/pull")
        .json(&json!({"model": ai::MODEL, "stream": true}))
        .send().map_err(|_| "Abra o Ollama antes de baixar o modelo.".to_string())?
        .error_for_status().map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(response);
    let mut success = false;
    loop {
        let mut line = String::new();
        let bytes = reader.by_ref().take(65537).read_line(&mut line).map_err(|error| error.to_string())?;
        if bytes == 0 { break; }
        if bytes > 65536 { return Err("Resposta de download maior que o limite permitido.".into()); }
        let item: Value = serde_json::from_str(&line).map_err(|_| "Resposta de download inválida.")?;
        if let Some(error) = item["error"].as_str() { return Err(error.chars().take(500).collect()); }
        let message = item["status"].as_str().unwrap_or("Baixando");
        success |= message == "success";
        progress(ModelProgress {
            status: message.chars().take(160).collect(),
            total: item["total"].as_u64(),
            completed: item["completed"].as_u64(),
        });
    }
    let status = ai::status_impl();
    if !success || !status.model_ready {
        return Err("O download não confirmou a instalação do modelo. Verifique a conexão e tente novamente.".into());
    }
    Ok(status)
}

pub fn open_link(target: &str) -> Result<(), String> {
    let url = match target {
        "ollama" => "https://ollama.com/download/windows",
        _ => return Err("Destino não permitido.".into()),
    };
    #[cfg(windows)]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url).spawn().map_err(|error| error.to_string())?;
    Ok(())
}
