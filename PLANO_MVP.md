# Plano de implementação — Lumen Desktop (MVP)

Estado: escopo do piloto confirmado em 24/10/2026. As seções de arquitetura central e marcos de equipe abaixo são roteiro futuro, não critérios de aceite desta entrega local.

## 1. Objetivo

Transformar uma captação com nomes repetidos (como `C001.MP4`) em um acervo pesquisável, sem exigir que o cinegrafista saiba previamente a qual local pertence cada take. O aplicativo deve detectar a mídia, preservar uma cópia local dos originais, extrair pistas, sugerir agrupamentos por matéria/local e pedir revisão humana antes de aplicar a organização.

**Entrega vigente:** um usuário individual no Windows, interface inteira no Lumen Desktop, originais locais e IA opcional via Ollama (`qwen3-vl:4b-instruct`). Persistência local por JSON versionado e preferências/rascunhos locais; sem API, login, equipes ou dependência de nuvem. Organização principal **local → matéria**, com local não identificado como resultado válido. Mac/Linux e arquitetura SaaS multiempresa são evolução futura, sujeita a validação e armazenamento/autorização próprios.

## 2. Resultado mínimo que precisa funcionar

1. O usuário escolhe um cartão ou pasta de origem e uma pasta permanente de destino.
2. O Lumen inventaria vídeos/fotos e **copia** os originais para uma área de ingestão local, sem apagar nem renomear a origem. Confere tamanho e hash da cópia e mostra falhas.
3. Para cada arquivo, registra um ID próprio (não usa `C001.MP4` como identificador), caminho, tamanho, hash, data/hora, câmera, duração e metadados disponíveis. Gera miniaturas/prévias.
4. O usuário fornece a pauta/retranca e, opcionalmente, locais visitados. Ele não precisa associar manualmente cada arquivo a um lugar.
5. A IA local opcional analisa amostras autorizadas e devolve, **por arquivo**, descrição/tags e possíveis local/matéria, com evidências. Percentuais das regras são força indicativa, não confiança calibrada. Quando não houver evidência suficiente, usa **“local não identificado”**. Sem IA, revisão e ingestão continuam disponíveis.
6. O editor pesquisa o acervo, visualiza takes e corrige as sugestões. A aprovação grava um plano de organização auditável. O MVP **não move nem renomeia os originais automaticamente**; isso exige uma etapa posterior, explícita e reversível.

Critério de sucesso do piloto: uma captação real de pelo menos dois locais e uma matéria é ingerida sem colisão de nomes; o editor encontra os takes por busca e consegue revisar todos os casos incertos. Erros de IA não podem ser apresentados como fatos confirmados.

## 3. Evolução futura — arquitetura SaaS (fora do piloto local)

| Parte | Tecnologia inicial | Responsabilidade |
| --- | --- | --- |
| Aplicativo desktop | Tauri + React + TypeScript + Vite | Telas de acervo, ingestão, processamento e revisão. |
| Núcleo local | Rust, SQLite, FFprobe/FFmpeg | Acesso autorizado a cartão/pastas, cópia verificada, inventário, metadados, miniaturas e fila offline. |
| API central | Python + FastAPI | Identidade, organizações, dispositivos, captações, revisão, busca e autorização. |
| Processamento assíncrono | Fila + workers Python; Redis/Celery como opção inicial | Análise audiovisual separada da API, retries, limites por organização e escala independente. |
| Catálogo central | PostgreSQL; pgvector quando a busca semântica entrar | Dados isolados por organização: arquivos, tags, evidências, revisões e auditoria. |
| Dados de análise | Armazenamento de objetos com retenção definida | Somente miniaturas, amostras/proxies e outros dados que o cliente autorizar, isolados por organização. |

Next.js não é necessário para o aplicativo instalado. No protótipo de um cliente, um worker simples pode bastar; **antes da beta multiempresa, a fila durável e os workers separados são obrigatórios**. Redis/Celery é uma opção de implementação, não uma dependência conceitual. A API não executa análise pesada durante requisições.

Fluxo: `cartão/pasta → cópia local verificada → inventário/miniaturas → análise na nuvem → sugestões → revisão no mesmo aplicativo → catálogo pesquisável`.

**Limite importante:** catálogo central não disponibiliza os originais em outras máquinas. Caso vários editores precisem abrir os mesmos vídeos, será preciso escolher armazenamento compartilhado (NAS, servidor de arquivos ou nuvem para originais) em uma fase posterior.

**Regra de espaços:** cada acervo pertence a um espaço de trabalho (`tenant_id` interno). Um espaço pode ter uma pessoa ou uma equipe. Nenhuma busca, sugestão, miniatura, job ou log de um espaço pode ser acessado por outro sem ação explícita e autorizada. O `tenant_id` é determinado por identidade e associação validadas no servidor, nunca aceito isoladamente do aplicativo.

## 4. Roteiro de evolução (marcos originais, fora do aceite individual atual)

Antes de retomar M1 multiempresa, revisar identidade, autorização, sincronização, banco e privacidade. JSON local e o nome digitado de workspace não constituem isolamento multiempresa. Para o piloto atual, a ordem de trabalho é: checkpoints/retomada; inventário consistente e timeout; rascunhos e contexto; busca por data e agrupamento local/matéria; lote/reversões; layout V2; distribuição e piloto real.

### M0 — Decisões e material piloto

- Escolher 1–2 captações reais autorizadas com locais diferentes, nomes repetidos, fotos e ao menos um voo de drone quando disponível.
- Definir política de envio: quais miniaturas, frames, áudio/proxy e metadados podem sair do computador; retenção e exclusão.
- Definir espaços de trabalho pessoais e de equipe, papéis (proprietário/administrador/editor/cinegrafista), convites, cadastro de dispositivos e cobrança por espaço.
- Escolher a distribuição Linux inicial e disponibilizar máquinas de teste Windows, macOS e Linux; build em três sistemas não substitui teste com cartão real.
- Definir pasta permanente de ingestão e capacidade mínima de armazenamento; não considerar o cartão uma cópia permanente.
- Confirmar formatos/câmeras prioritários e quais arquivos de telemetria de drone existem de fato.
- Registrar Figma v2 como referência da interface e este documento como referência de escopo.

**Saída:** conjunto de teste anonimizado/autorizado e decisões de privacidade/armazenamento.

### M1 — Fundação executável

- Criar repositório, aplicativo Tauri/React/Vite e API FastAPI, com builds automatizados para Windows/macOS/Linux.
- Configurar PostgreSQL, migrações, SQLite local, configuração por ambiente, logs e testes automatizados básicos.
- Implementar usuários, espaço pessoal criado no cadastro, associação usuário-espaço, papéis, dispositivos e comunicação autenticada com a API.
- Preparar isolamento por espaço na API, banco, armazenamento, fila local e logs; testes que tentam acessar dados de outro espaço.
- Reproduzir no aplicativo o shell e a navegação das quatro telas do Figma, inicialmente com dados de demonstração.

**Aceite:** instalador Windows abre o app; builds macOS/Linux são gerados; API responde; aplicativo identifica online/offline sem perder a interface. Uma pessoa entra sozinha no espaço pessoal; uma equipe compartilha o catálogo; testes de isolamento entre dois espaços passam.

### M2 — Ingestão local segura (primeira fatia ponta a ponta)

- Autorizar apenas pastas selecionadas pelo usuário; detectar inserção de mídia e permitir seleção manual.
- Exibir e exigir confirmação do espaço de trabalho ativo antes de iniciar uma ingestão; a captação não pode mudar de espaço silenciosamente.
- Listar arquivos sem modificar a origem; copiar para área local de ingestão usando nome/ID único e preservar o nome original no catálogo.
- Verificar tamanho e hash após a cópia, permitir retomar falhas e impedir que uma cópia incompleta apareça como concluída.
- Extrair metadados com FFprobe e gerar uma ou mais miniaturas por vídeo.
- Salvar estado e fila localmente para continuar após reinício ou queda de conexão.

**Aceite:** dois arquivos `C001.MP4` de cartões/dias diferentes coexistem, são rastreáveis até a origem e não se sobrescrevem. O aplicativo não declara o cartão “seguro para formatar” sem cópia verificada.

### M3 — Contexto e sugestões por arquivo

- Formulário de pauta, retranca e locais visitados opcionais.
- Contrato de API para captação, arquivo, evidência e sugestão; envio consentido de metadados e amostras/proxies necessários.
- Introduzir fila durável e workers separados antes da beta multiempresa: jobs idempotentes, retries limitados, estado observável e limite de concorrência por organização.
- Começar com regras verificáveis: horário, sequência, câmera, GPS/telemetria quando existirem e pistas textuais da pauta. Adicionar análise visual/áudio de forma incremental.
- Gravar proveniência de cada sugestão (`GPS`, placa/OCR, áudio, horário etc.), confiança e versão do modelo/regra.
- Não transformar geocodificação de drone ou reconhecimento visual em certeza: se a evidência for fraca ou conflitante, usar “local não identificado”.

**Aceite:** cada take recebe uma sugestão ou uma indicação clara de incerteza, com justificativa inspecionável. O editor consegue comparar a sugestão com o vídeo.

### M4 — Revisão, aprovação e acervo

- Exibir takes agrupados por local/matéria, filtro “precisa revisar”, miniaturas e painel de evidências.
- Permitir corrigir local, matéria e tags por take ou em lote; guardar quem mudou, quando e valor anterior.
- Implementar aprovação de um **plano lógico de organização** sem mover o original; permitir desfazer a aprovação/correção.
- Busca por nome original, data, local, matéria e tags. Acrescentar busca semântica com pgvector apenas após validar utilidade no material piloto.
- Todas as buscas e prévias são filtradas por organização e autorização; cache e índices também usam escopo da organização.
- Mostrar disponibilidade do original: neste computador, em armazenamento compartilhado ou indisponível.

**Aceite:** editor localiza takes por “pessoas em lojas” e por matéria/local, entende quais resultados são sugestões e consegue corrigir e aprovar sem alterar os arquivos originais.

### M5 — Piloto e endurecimento

- Testar com cartão removido durante a leitura, disco cheio, arquivos corrompidos, mesma nomenclatura, horário errado, ausência de GPS, internet fora e reinício do aplicativo.
- Medir tempo de inventário, volume de dados enviados, custo por captação e qualidade das sugestões (precisão por local e taxa de “não identificado”).
- Testar permissões de pasta, autenticação, proteção de dados, política de retenção e recuperação de falhas.
- Fazer teste de carga com várias organizações e ingestões simultâneas; medir filas, custo de IA, armazenamento de prévias e impacto de um cliente muito ativo nos demais.
- Validar ingestão real e empacotamento em Windows, macOS (Intel/Apple Silicon, se forem alvo) e Linux escolhido; preparar assinatura/notarização quando aplicável.
- Ajustar o modelo/regras com as correções do editor, sem usar material do cliente para treinamento não autorizado.

**Aceite:** piloto termina uma captação real com cópias verificadas, busca útil e revisão concluída; falhas não geram perda ou sobrescrita de mídia.

## 5. Modelo de dados mínimo

- `Capture`: ID, pauta, retranca, datas, equipe, status.
- `Workspace` (`tenant_id` interno): espaço pessoal ou de equipe, plano, política de retenção e limites.
- `User`, `Membership`, `Device`: pessoa, papel em cada espaço, espaços autorizados e instalações do agente.
- `Source`: cartão/pasta, dispositivo, data de detecção.
- `Asset`: ID interno, `capture_id`, tipo, nome original, caminhos locais, tamanho, hash, duração, câmera, horário, status da cópia.
- `Evidence`: `asset_id`, tipo (GPS/OCR/áudio/visual/horário), valor, origem e qualidade.
- `Suggestion`: `asset_id`, local/matéria/tags sugeridos, confiança, justificativa, versão do analisador.
- `Review`: `asset_id`, decisão humana, alterações, autor, data e histórico.
- `Job`: etapa, progresso, tentativas e erro recuperável.
- `AuditEvent` e `UsageRecord`: mudanças, acessos sensíveis, volume processado e consumo por organização.

Todo registro central pertencente a um espaço leva `tenant_id` e é protegido por autorização no servidor e políticas de banco. Uma pessoa pode pertencer a vários espaços sem misturar dados. Caminhos locais não devem ser expostos como se fossem links acessíveis a outros computadores.

O nome de arquivo nunca é chave primária. Identificadores e hashes permitem distinguir captações sucessivas que reutilizam `C001.MP4`.

## 6. O que fica fora do primeiro MVP

- Servidor instalado em cada cliente; painel web separado; aplicativo móvel.
- Transferir todos os originais para a nuvem por padrão.
- Mover/renomear automaticamente originais, formatar cartão ou apagar mídia de origem.
- Reconhecer com certeza toda praia/loja apenas pela imagem, sem GPS ou evidência suficiente.
- Suporte a todos os modelos de drone, formatos proprietários e distribuições Linux desde o início.
- Colaboração multiestação com acesso aos mesmos originais sem armazenamento compartilhado.
- Java/Angular e Next.js: alternativas futuras, não parte da primeira implementação.

## 7. Primeiras tarefas para começar a codificar

1. Selecionar os arquivos piloto e responder às decisões de M0.
2. Inicializar Git e a estrutura `apps/desktop`, `services/api`, `services/worker`, `packages/contracts` e `docs` nesta pasta.
3. Subir um Lumen Desktop vazio com navegação entre as quatro telas e um endpoint `/health` na API.
4. Implementar primeiro o caminho **pasta de origem → cópia verificada → inventário local**, antes de conectar IA.
5. Adicionar um teste automatizado com dois arquivos de mesmo nome em captações diferentes.
6. Adicionar um teste de segurança com duas organizações: uma não pode obter arquivos, miniaturas ou jobs da outra.
7. Adicionar testes dos três modos: usuário sozinho, dois editores no mesmo espaço e um usuário em dois espaços distintos sem vazamento de dados.

## Referências técnicas

- Tauri, frontend e Vite: https://v2.tauri.app/start/frontend/
- Tauri, permissões de arquivos: https://v2.tauri.app/plugin/file-system/
- FFprobe: https://ffmpeg.org/ffprobe.html
- FastAPI e tarefas em segundo plano: https://fastapi.tiangolo.com/tutorial/background-tasks/
- pgvector: https://github.com/pgvector/pgvector
