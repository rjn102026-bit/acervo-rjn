# Lumen — MVP

## Escopo vigente — 24/10/2026

Piloto **local individual no Windows**, com Tauri + React/TypeScript + Rust. A análise visual é opcional e roda no Ollama deste computador. Login, equipes, API, catálogo em nuvem e isolamento multiempresa ficam para uma fase posterior. O workspace atual é apenas uma separação local de pastas.

A revisão e as cópias exportadas seguem **local → matéria**. Um local incerto permanece “Local não identificado”; uma sugestão de IA não vira confirmação humana. A aprovação do conjunto preserva a origem de cada decisão.

O inventário é salvo antes da primeira cópia e há checkpoints imutáveis por arquivo. Acervo e Processamento permitem **Retomar ingestão** na mesma captação, com a origem original conectada. Tamanho e data do inventário são conferidos para arquivos pendentes; cópias finais recuperadas são comparadas por SHA-256 com a origem. Uma cópia preexistente diferente nunca é sobrescrita. A retomada continua por arquivo, não a partir de um byte intermediário. Miniaturas pendentes podem ser tentadas novamente sem recópia.

Rascunhos de revisão e as últimas pastas ficam no armazenamento local da interface. A análise interrompida pode ser retomada por ação do usuário, reutilizando resultados concluídos. Essa persistência é de piloto: JSON versionado para captações e registros, armazenamento local da interface para preferências e intenção da fila; SQLite e sincronização não fazem parte desta entrega.

Há edição em lote com validação integral, autoria local do sistema operacional, restauração da revisão anterior e revogação auditável da aprovação. Essa autoria não é uma conta autenticada. Arquivos exportados anteriormente permanecem associados à aprovação que os gerou.

Primeira fatia do Lumen Desktop: interface React dentro do Tauri e núcleo Rust para ingestão local segura de mídia. Os arquivos de origem nunca são alterados; cada cópia recebe um ID próprio, tem o hash SHA-256 conferido e entra em um manifesto por captação.

## Estado atual

- Criado: estrutura Tauri 2 + React/TypeScript/Vite, telas de ingestão, processamento, acervo e revisão por take, comandos Rust de cópia verificada, pauta e locais visitados por captação, leitura de metadados com FFprobe, geração de miniaturas com FFmpeg e listagem de manifestos. A origem e o destino aparecem juntos no formulário; o Acervo pesquisa por nomes, retranca, pauta e decisões humanas de local, matéria e tags. A tela de Processamento exibe uma captação por vez e permite tentar novamente metadados/miniaturas sem recopia dos originais. A revisão permite visualizar fotos JPEG/PNG e reproduzir MP4 compatível com o player do sistema, confirmar um local, registrar “local não identificado” ou manter pendente, além de matéria, tags e observação por mídia; cada alteração gera um evento imutável no histórico local. A primeira camada de evidências lê coordenadas GPS presentes em metadados de mídia e um trajeto de arquivos SRT de mesmo nome e pasta do vídeo. Regras locais sugerem local quando há nome explícito nos metadados, correspondência única entre nome do arquivo e local visitado, cópia idêntica já confirmada por editor ou GPS até 300 m de uma mídia confirmada e estacionária. Cada sugestão mostra a justificativa e uma força indicativa ainda não calibrada; o editor precisa conferir e salvar a decisão. Nada é confirmado automaticamente.
- Validação automatizada: `npm run build`, `npm test`, `cargo test --offline --lib` e `python -m unittest discover -s tests -v`. Os testes cobrem colisão de nomes, recuperação de checkpoints, origem alterada, exportação por local/matéria, revisão em lote, reversão, timeout e regressões de busca/agrupamento. Não substituem homologação com cartão real, disco cheio e máquina limpa.
- Fora do piloto: autenticação multiusuário, catálogo na nuvem, transcrição/análise de áudio, geocodificação de GPS, suporte completo a MXF/RAW e reorganização dos arquivos de origem. A busca é **textual local**, por nomes, datas, contexto, decisões humanas e análises visuais existentes; não é busca semântica. O reprocessamento trata prévias; o comando separado de retomada trata cópias pendentes/com falha.
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

Esta CLI Python é mantida como referência testável da regra de ingestão. A implementação Rust do desktop tem testes próprios, progresso por arquivo e retomada das cópias pendentes ou com falha na mesma captação.


## IA visual local — Qwen3-VL 4B e Ollama

O desktop conecta ao Ollama em `127.0.0.1:11434` usando **`qwen3-vl:4b-instruct`**. Instale e abra o Ollama, execute `ollama pull qwen3-vl:4b-instruct` e clique em **Atualizar conexão** nas opções de IA local. O modelo genérico `qwen3-vl:4b` não satisfaz a checagem de instalação atual.

A análise começa automaticamente após a cópia verificada quando a IA local está pronta. Em Processamento, use **Analisar e separar takes** para iniciar ou completar a organização. Na Revisão é possível analisar ou reanalisar um take. No modo rápido o modelo recebe uma imagem por foto ou um quadro central por vídeo. No modo detalhado são três quadros (10%, 50% e 90% da duração); sem duração disponível, usa um quadro inicial. A extração depende do FFmpeg. Não há transcrição de áudio nem leitura de todos os quadros.

Descrição, texto visível e tags sugeridas aparecem na revisão e entram na busca textual local. A IA prepara categorias, assuntos e tags automaticamente. Locais podem vir de pistas visuais específicas e permanecer não identificados sem bloquear a organização por conteúdo. O usuário revisa apenas exceções e aprova o conjunto. A IA não altera as decisões existentes nem aprova automaticamente. A aprovação da organização registra as decisões salvas e preserva os originais.

Os resultados de IA são registros versionados em `visual-analysis/` dentro da captação, associados ao hash da mídia e ao contexto. Resultados compatíveis são reutilizados. A fila é sequencial e pode parar após o take atual; cada tentativa de solicitação ao modelo tem limite de sete minutos. A integração usa apenas a API local, sem proxy e sem redirecionamento para servidores externos.

As correções de QA têm testes automatizados. Qualidade da inferência em mídias reais e comparação visual integral com o arquivo vivo do Figma permanecem etapas de homologação.

## Build de distribuição

Na pasta `apps/desktop`, use `npm run build:desktop` para gerar `src-tauri/target/release/lumen_desktop.exe` com HTML, CSS e JavaScript embutidos. Esse comando usa o Tauri CLI, que ativa `tauri/custom-protocol`. O executável de distribuição não depende do Vite nem da porta 1420.

O código bloqueia a compilação de release sem o protocolo de produção. Não distribua executáveis gerados por `cargo rustc --release` sem `tauri/custom-protocol`: eles podem apontar para `localhost:1420` mesmo estando em uma pasta chamada release.


Organização automática: os resultados atuais incluem categoria, assunto, tags e indicação de exceções. A revisão projeta esses resultados no catálogo sem criar confirmações humanas fictícias. A aprovação em lote aceita os takes organizados pela IA e exige atenção apenas aos itens sem análise ou com exceções. Há correção opcional de categoria e campos existentes. A geração usa /api/chat, esquema JSON compacto, duas tentativas e reaproveitamento de análises de duplicatas de mesmo hash e contexto.

## Correções da revisão de QA — 24/10/2026

Escopo aprovado: piloto local individual no Windows, com organização **local → matéria**. Login, equipes e nuvem permanecem para outra fase.

Fluxo de uso: em Nova ingestão, selecione origem e destino; nome, pauta e locais são opcionais. Ao terminar a cópia verificada, o aplicativo abre Processamento e inicia a IA automaticamente se o Ollama/modelo estiver pronto. Se não estiver, a tela oferece a configuração e o início manual. A Revisão mostra quantos takes a IA analisou, permite completar os pendentes e apresenta os grupos por local → matéria; a pessoa confere as exceções e aprova. Depois da aprovação, é possível iniciar a cópia organizada em pastas local/matéria; a origem permanece intacta.

- Segurança da ingestão: inventário e checkpoints persistidos, retomada sem sobrescrever cópias diferentes, detecção de origem alterada, proteção de caminhos e timeout dos processos externos.
- Consistência do catálogo: busca entre captações, agrupamento por local/matéria, distinção entre sugestão da IA e confirmação humana e proteção contra respostas assíncronas antigas.
- Revisão: rascunhos persistidos, bloqueio de aprovação com alterações não salvas, edição em lote validada, autoria local, restauração de decisões e revogação auditável da aprovação.
- Interface: configurações técnicas recolhidas, estado real dos dispositivos, fonte Inter empacotada com licença e ajustes de navegação/ações. Comparação visual integral com o Figma ainda não homologada.
- Distribuição: executável de produção reconstruído com interface embutida e aberto com Vite desligado; não depende de terminal ou servidor de desenvolvimento.

Validações desta entrega: 8 testes de catálogo/frontend, 13 testes Rust e 3 testes Python passaram. O teste auxiliar Rust marcado como ignorado é executado pelo teste de timeout. Build desktop e `git diff --check` passaram.

Smoke test na janela de produção: ingestão de uma foto e um vídeo sintéticos, ambos verificados com metadados e miniaturas, e abertura da revisão com os dois itens pendentes. Não foi uma homologação completa de todas as ações da interface nem de inferência por IA. Os arquivos sintéticos foram mantidos separadamente em `C:\Users\Angelo\Documents\Codex\lumen-qa-cf45d0a5`; nenhum arquivo do pendrive foi copiado nesse teste.

Antes da distribuição pública: empacotar FFmpeg e revisar suas licenças; validar instalador em Windows limpo; testar interrupção/remoção de cartão, disco cheio e volume real; homologar a qualidade da IA e a fidelidade ao Figma. macOS/Linux e multiusuário não foram homologados nesta entrega.

