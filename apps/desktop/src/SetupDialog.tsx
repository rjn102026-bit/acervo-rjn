import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./setup.css";
import rjnMark from "./assets/rjn-mark.svg";

type InstallationStatus = {
  tools: { name: string; available: boolean; bundled: boolean; version: string | null }[];
  ai: { running: boolean; model_ready: boolean; model: string; message: string };
};
type ModelProgress = { status: string; total: number | null; completed: number | null };

export default function SetupDialog({ onClose, onContinue }: {
  onClose: () => void;
  onContinue: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const [status, setStatus] = useState<InstallationStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const [error, setError] = useState("");
  const toolsReady = !!status?.tools.length && status.tools.every((tool) => tool.available);

  async function refresh() {
    setChecking(true);
    setError("");
    try {
      const result = await invoke<InstallationStatus>("get_installation_status");
      if (alive.current) setStatus(result);
    } catch (failure) {
      if (alive.current) setError(String(failure));
    } finally {
      if (alive.current) setChecking(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    void refresh();
    return () => { alive.current = false; };
  }, []);

  async function download() {
    setDownloading(true);
    setProgress(null);
    setError("");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<ModelProgress>("setup-model-progress", (event) => {
        if (alive.current) setProgress(event.payload);
      });
      await invoke("download_ai_model");
      if (alive.current) await refresh();
    } catch (failure) {
      if (alive.current) setError(String(failure));
    } finally {
      unlisten?.();
      if (alive.current) setDownloading(false);
    }
  }
  const percent = progress?.total && progress.completed != null
    ? Math.min(100, Math.round(progress.completed / progress.total * 100))
    : null;

  return (
    <dialog ref={dialog} className="setup-dialog" aria-labelledby="setup-title"
      onCancel={(event) => {
        if (downloading) event.preventDefault();
        else onClose();
      }}>
      <div className="setup-heading">
        <img className="setup-brand" src={rjnMark} alt="RJN Systems" width="44" height="48" />
        <div>
          <span className="eyebrow">LUMEN / PRIMEIROS PASSOS</span>
          <h2 id="setup-title">Preparar este computador</h2>
          <span className="hint">Lumen — por RJN Systems</span>
        </div>
        <button className="secondary" type="button" onClick={onClose} disabled={downloading}>Fechar</button>
      </div>
      <p>Confira as ferramentas para trabalhar com suas fotos e vídeos. A análise por IA é opcional e acontece neste computador.</p>
      <section className="setup-section" aria-label="Ferramentas de mídia">
        <div className="setup-row">
          <h3>Fotos, vídeos e miniaturas</h3>
          <span className="badge">{checking ? "Verificando…" : toolsReady ? "Pronto" : "Precisa de atenção"}</span>
        </div>
        {status?.tools.map((tool) => (
          <div className="setup-tool" key={tool.name}>
            <strong>{tool.name === "ffmpeg" ? "Prévias e miniaturas" : "Leitura de metadados"}</strong>
            <span>{tool.available ? tool.bundled ? "Incluído no Lumen" : "Disponível no computador" : "Ferramenta não encontrada"}</span>
          </div>
        ))}
        {!checking && !toolsReady && <p role="status">Reinstale o pacote completo do Lumen para recuperar as ferramentas de mídia.</p>}
      </section>
      <section className="setup-section" aria-label="Configuração da IA">
        <div className="setup-row">
          <h3>Organização por IA local</h3>
          <span className="badge">{checking ? "Verificando…" : status?.ai.model_ready ? "Pronta" : "Opcional"}</span>
        </div>
        {status?.ai.model_ready ? (
          <p>O Ollama e o modelo Qwen3-VL 4B Instruct estão prontos para analisar as mídias.</p>
        ) : (
          <>
            <p>{status?.ai.running
              ? "O Ollama está aberto. Baixe o modelo uma vez para habilitar a análise."
              : "Instale e abra o Ollama. Depois, verifique novamente para baixar o modelo da IA."}</p>
            <p className="hint">O download inicial requer internet e vários GB de espaço. O tempo de análise depende do computador.</p>
            <div className="setup-actions">
              {!status?.ai.running && <button className="secondary" type="button"
                onClick={() => void invoke("open_setup_link", { target: "ollama" }).catch((failure) => setError(String(failure)))}>
                Baixar Ollama
              </button>}
              {status?.ai.running && !status.ai.model_ready && <button className="primary" type="button"
                disabled={downloading || checking} onClick={() => void download()}>
                {downloading ? "Baixando modelo…" : "Baixar modelo da IA"}
              </button>}
            </div>
          </>
        )}
        {downloading && <div className="setup-download" role="status" aria-live="polite">
          <p>{percent == null ? "Preparando o download…" : "Baixando arquivos do modelo — etapa atual: " + percent + "%"}</p>
          {percent == null ? <progress aria-label="Download do modelo" /> : <progress max={100} value={percent} aria-label="Download da etapa atual do modelo" />}
          <p className="hint">Mantenha o Lumen e o Ollama abertos até concluir.</p>
        </div>}
      </section>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="setup-footer">
        <button className="secondary" type="button" disabled={checking || downloading} onClick={() => void refresh()}>
          {checking ? "Verificando…" : "Verificar novamente"}
        </button>
        <button className="primary" type="button" disabled={!toolsReady || checking || downloading} onClick={onContinue}>
          {status?.ai.model_ready ? "Começar a usar" : "Continuar sem IA por enquanto"}
        </button>
      </div>
      <details className="setup-licenses">
        <summary>Componentes e licenças</summary>
        <p>O Lumen utiliza FFmpeg/FFprobe LGPL como programas externos. A pasta ffmpeg da instalação contém a licença, informações da compilação e arquivos-fonte do FFmpeg e das receitas de build. A interface utiliza a fonte Inter sob licença SIL Open Font License.</p>
      </details>
    </dialog>
  );
}
