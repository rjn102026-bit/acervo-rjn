# Lumen — MVP

Primeira fatia do Lumen Desktop: interface React dentro do Tauri e núcleo Rust para ingestão local segura de mídia. Os arquivos de origem nunca são alterados; cada cópia recebe um ID próprio, tem o hash SHA-256 conferido e entra em um manifesto por captação.

## Estado atual

- Criado: estrutura Tauri 2 + React/TypeScript/Vite, telas de ingestão, processamento, acervo e revisão por take, comandos Rust de cópia verificada, pauta e locais visitados por captação, leitura de metadados com FFprobe, geração de miniaturas com FFmpeg e listagem de manifestos. A origem e o destino aparecem juntos no formulário; o Acervo pesquisa por nomes, retranca, pauta e decisões humanas de local, matéria e tags. A tela de Processamento exibe uma captação por vez e permite tentar novamente metadados/miniaturas sem recopia dos originais. A revisão permite visualizar fotos JPEG/PNG e reproduzir MP4 compatível com o player do sistema, confirmar um local, registrar “local não identificado” ou manter pendente, além de matéria, tags e observação por mídia; cada alteração gera um evento imutável no histórico local. A primeira camada de evidências lê coordenadas GPS presentes em metadados de mídia e um trajeto de arquivos SRT de mesmo nome e pasta do vídeo. Regras locais sugerem local quando há nome explícito nos metadados, correspondência única entre nome do arquivo e local visitado, cópia idêntica já confirmada por editor ou GPS até 300 m de uma mídia confirmada e estacionária. Cada sugestão mostra a justificativa e uma força indicativa ainda não calibrada; o editor precisa conferir e salvar a decisão. Nada é confirmado automaticamente.
- Verificado nesta máquina antes da última ampliação das regras: build da interface React, 9 testes Rust da ingestão/revisão/prévia/evidências, três testes do protótipo Python, leitura de metadados e geração de miniatura com vídeo sintético. O usuário também confirmou o fluxo interativo de ingestão com mídia real. As regras de propagação por hash e GPS foram implementadas depois dessa rodada; a pedido do usuário, a compilação e os testes delas ficam para uma etapa posterior. Um teste anterior revelou que `target/debug/lumen_desktop.exe` depende de `localhost`; use apenas o build de release em `target/release/lumen_desktop.exe` para abrir sem servidor. Use o executável de release gerado na atualização correspondente.
- Ainda não implementado: retomada de cópia interrompida, autenticação multiusuário, catálogo na nuvem, transcrição/análise de áudio por IA, geocodificação de GPS para nome de local, prévia completa de formatos como MXF/RAW e aplicação física da organização aos originais. A busca atual é **textual local**, incluindo decisões humanas, incluindo descrições, tags e texto visível já produzidos pela IA local; não é busca vetorial. Coordenadas, data, resolução e codec são pistas técnicas, não prova de qual praia, loja ou bairro aparece no take. O editor decide e registra o local manualmente. A nova tentativa de processamento salva um manifesto de revisão imutável por captação; não corrige falhas de cópia. Esses itens estão planejados em [PLANO_MVP.md](PLANO_MVP.md).
- A organização física dos originais não é alterada. Não formate cartões com base apenas neste protótipo: mantenha a rotina de backup da sua equipe.

## Desktop (arquitetura escolhida)

Requer Node.js 20+ (build atual testado com Node 24), Rust com toolchain MSVC, Microsoft C++ Build Tools e WebView2 no Windows. Na pasta `apps/desktop`:

```powershell
npm install
npm run build
npm run tauri dev
npm run tauri -- build --no-bundle
```

Para abrir o aplicativo **sem servidor de desenvolvimento**, use `apps/desktop/src-tauri/target/release/lumen_desktop.exe` após `build --no-bundle`. O executável em `target/debug` é de desenvolvimento e pode tentar abrir `localhost`; não o entregue para teste independente.

No desktop, selecione **pastas já existentes** de origem e destino em volumes/pastas separados. O espaço digitado é apenas uma separação local provisória: não é autenticação e não deve ser usado como isolamento de clientes em uma versão distribuída. Contas, associação usuário-espaço e autorização virão com a API central.

Para este piloto, o aplicativo procura `ffprobe` e `ffmpeg` na instalação do Chocolatey no Windows e, como alternativa, no `PATH` do sistema; o usuário não informa caminho no formulário. Se não estiverem disponíveis, a cópia verificada continua funcionando e o manifesto registra a falha do processamento. Depois de disponibilizar as ferramentas, a tela de Processamento permite tentar novamente metadados/miniaturas das cópias verificadas; ela não repete a ingestão nem corrige cópias com falha. O MVP ainda não inclui os binários FFmpeg no instalador. Antes de distribuir a outros usuários, é preciso resolver o empacotamento e as obrigações de licença; a dependência manual atual não é a experiência final.

O ícone verde com “L” é **provisório**, criado apenas para satisfazer o empacotamento Windows; a identidade RJN final precisa substituí-lo antes da distribuição.

## Protótipo de validação da regra

Requer Python 3.11+ (sem pacotes externos). Execute a partir desta pasta:

```powershell
python -m lumen_local ingest --source "D:\Cartao" --destination "D:\Acervo" --workspace "cliente-a" --capture "Comércio Dia das Crianças"
python -m unittest discover -s tests -v
```

`--source` deve apontar para a pasta do cartão **ou para uma pasta de teste**; `--destination` deve estar em outro volume/pasta permanente e não pode estar dentro da origem. O comando cria `destination/workspaces/<id>/captures/<id>/originals/` e um `manifest.json`. O nome original fica registrado, mas não é usado como chave nem como nome único da cópia.

Esta CLI Python é mantida como referência testável da regra de ingestão. A implementação Rust do desktop já compila e tem testes próprios. Barra de progresso, retomada e confirmação mais detalhada serão incrementos posteriores.


## IA visual local — Qwen3-VL 4B e Ollama

O desktop conecta ao Ollama em `127.0.0.1:11434` usando `qwen3-vl:4b`. Instale e abra o Ollama, execute `ollama pull qwen3-vl:4b` e clique em **Atualizar conexão** no Lumen.

A análise pode começar após a cópia verificada ou pelo botão **Analisar captação com IA**, em Processamento. Na Revisão é possível analisar ou reanalisar um take. O modelo recebe uma imagem de fotos ou até três quadros amostrados de vídeos (10%, 50% e 90% da duração; um quadro inicial quando a duração não estiver disponível). A extração depende do FFmpeg. Não há transcrição de áudio nem leitura de todos os quadros.

Descrição, texto visível e tags sugeridas aparecem na revisão e entram na busca textual local. A IA prepara categorias, assuntos e tags automaticamente. Locais podem vir de pistas visuais específicas e permanecer não identificados sem bloquear a organização por conteúdo. O usuário revisa apenas exceções e aprova o conjunto. A IA não altera as decisões existentes nem aprova automaticamente. A aprovação da organização registra as decisões salvas e preserva os originais.

Os resultados de IA são registros versionados em `visual-analysis/` dentro da captação, associados ao hash da mídia e ao contexto. Resultados compatíveis são reutilizados. A fila é sequencial e pode parar após o take atual; cada tentativa de solicitação ao modelo tem limite de sete minutos. A integração usa apenas a API local, sem proxy e sem redirecionamento para servidores externos.

Nesta atualização, testes e inferência de validação em mídias reais foram pulados a pedido do usuário; apenas compilação e preparação das dependências.

## Build de distribuição

Na pasta `apps/desktop`, use `npm run build:desktop` para gerar `src-tauri/target/release/lumen_desktop.exe` com HTML, CSS e JavaScript embutidos. Esse comando usa o Tauri CLI, que ativa `tauri/custom-protocol`. O executável de distribuição não depende do Vite nem da porta 1420.

O código bloqueia a compilação de release sem o protocolo de produção. Não distribua executáveis gerados por `cargo rustc --release` sem `tauri/custom-protocol`: eles podem apontar para `localhost:1420` mesmo estando em uma pasta chamada release.


Organização automática: os resultados atuais incluem categoria, assunto, tags e indicação de exceções. A revisão projeta esses resultados no catálogo sem criar confirmações humanas fictícias. A aprovação em lote aceita os takes organizados pela IA e exige atenção apenas aos itens sem análise ou com exceções. Há correção opcional de categoria e campos existentes. A geração usa /api/chat, esquema JSON compacto, duas tentativas e reaproveitamento de análises de duplicatas de mesmo hash e contexto.

