# Distribuição Windows — piloto

O pacote NSIS instala o Lumen por usuário, cria atalhos e inclui FFmpeg/FFprobe com suas DLLs. O bootstrapper do WebView2 acompanha o instalador e instala o runtime, pela internet, caso esteja ausente.

## Gerar o pacote

Na pasta apps/desktop:

~~~powershell
npm ci
npm run build:installer
~~~

O Tauri aplica tauri.windows.conf.json automaticamente. Antes de compilar, prepare:windows baixa a versão fixada em scripts/windows-dependencies.json, verifica os SHA-256, extrai FFmpeg/FFprobe e DLLs e executa uma verificação de versão. O cache fica em src-tauri/target/dependencies e os recursos gerados em src-tauri/resources/ffmpeg; ambos ficam fora do Git.

A saída fica em src-tauri/target/release/bundle/nsis/*-setup.exe. Se CARGO_TARGET_DIR estiver definido, procure em CARGO_TARGET_DIR/release/bundle/nsis.

Distribua o arquivo -setup.exe, em vez do executável avulso. Os recursos externos não estão embutidos no executável avulso. O computador do piloto não precisa de Node, Rust, Python, Chocolatey ou FFmpeg pré-instalados.

## Primeira abertura

1. “Preparar este computador” verifica miniaturas, metadados, Ollama e o modelo.
2. As ferramentas de mídia devem aparecer como incluídas no Lumen.
3. Para IA, use “Baixar Ollama”, instale e abra o aplicativo pelo site oficial e clique em “Verificar novamente”.
4. Use “Baixar modelo da IA” para solicitar ao Ollama qwen3-vl:4b-instruct. O download exige internet e vários GB; a tela acompanha o progresso da etapa atual.
5. É possível continuar sem IA e configurar depois em Configurações → Verificar instalação e IA.

A análise usa Ollama em 127.0.0.1:11434; as mídias não vão à nuvem. O comando de download aceita apenas o modelo fixado no código, sem URL ou comando arbitrário da interface.

## Requisitos

- Windows x64; o pacote FFmpeg adotado tem suporte mínimo declarado a Windows 10 22H2.
- Espaço para aplicativo, modelo e cópias do acervo. O modelo não acompanha o instalador.
- Internet quando for necessário instalar WebView2, Ollama ou baixar o modelo. Depois, leitura e análise são locais.
- A velocidade da IA depende da memória e do hardware e exige homologação nas máquinas do piloto.

## Proveniência e licenças

O FFmpeg vem de BtbN/FFmpeg-Builds, release mensal autobuild-2026-09-30-13-08, variante n9.0.2-17-g2a571b6068-win64-lgpl-shared-9.0. O script recusa builds com --enable-gpl ou --enable-nonfree e distribui as DLLs sem modificações.

Na pasta ffmpeg da instalação ficam LICENSE.txt, NOTICE.txt, BUILD-INFO.txt, PROVENANCE.json e os arquivos-fonte correspondentes do FFmpeg e das receitas de compilação. O FFmpeg é chamado como processo externo; o Lumen não faz vínculo com suas bibliotecas.

Antes de disponibilizar um download público, concluir a revisão dos avisos e da correspondência de fontes das dependências transitivas do build FFmpeg. Os fontes do FFmpeg e as receitas não representam, por si só, um arquivo completo de fontes de todas essas dependências. Preservar e hospedar os materiais de fonte aplicáveis junto da distribuição.

## Homologação

- Conferir extração, DLLs e execução das ferramentas sem FFmpeg do sistema no PATH.
- Conferir primeira abertura, verificação e adiamento da IA.
- Validar instalação/desinstalação em Windows limpo sem ferramentas pré-instaladas.
- Validar falta de internet, retomada do download do modelo, pouco espaço e atualização de versão.

Este piloto não recebe assinatura digital. Gerar o pacote não confirma instalação em máquina limpa nem elimina avisos de reputação do Windows.

## Verificações executadas em 25/10/2026

- TypeScript e build de produção React/Vite concluídos.
- Build Rust e pacote NSIS concluídos: 68,68 MiB.
- Extração do NSIS pelo 7-Zip confirmou aplicativo, bootstrapper WebView2, nove executáveis/DLLs de mídia, licenças e arquivos de origem.
- Os hashes dos nove arquivos de mídia extraídos conferem com os recursos preparados.
- A assinatura do bootstrapper WebView2 foi validada como Microsoft Corporation.
- FFmpeg/FFprobe incluídos geraram vídeo e miniatura sintéticos e leram a resolução 160 × 96 sem FFmpeg do sistema no PATH.
- O aplicativo extraído foi aberto sem executar o instalador. A primeira abertura confirmou as duas ferramentas como “Incluído no Lumen” e detectou o Ollama/modelo existentes nesta máquina. A janela de conferência foi encerrada.
- O download do modelo não foi repetido, pois o modelo já estava disponível. Instalação em Windows limpo, ausência de Ollama e download real do modelo continuam pendentes de homologação.

SHA-256 do pacote gerado:

    2f267d4b1517a01f5bcdbabf1408d055fe974b648efa88c38b8fe7b665275642

A marca RJN é exportada da página Logo do Figma, sem reconstrução dos traços. `src/assets/rjn-mark.svg` atende à interface; `app-icon.svg` adiciona margem e fundo para gerar os ícones com `npm run tauri -- icon app-icon.svg`.

Versão 0.1.1: ícone RJN aplicado explicitamente às janelas na inicialização. Executável aberto e ícone da barra de título conferido visualmente.
