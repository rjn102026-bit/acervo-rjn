# Arquitetura proposta — Lumen SaaS multiempresa

Estado: decisão inicial para implementação; validar custos, privacidade e desempenho no piloto.

## Premissas

- O produto atende **três formatos com a mesma arquitetura**: profissional individual, equipe de uma empresa e vários clientes/empresas independentes. A unidade de acervo e isolamento é o **espaço de trabalho** (`Workspace`, chamado `tenant` internamente), que pode ter um ou vários membros.
- Cada computador que acessa cartões ou originais instala o Lumen Desktop. O cliente **não precisa instalar um servidor**.
- A nuvem centraliza identidade, catálogo, sugestões, busca e filas. Os vídeos originais continuam sob controle do cliente, exceto se ele contratar/autorizar armazenamento compartilhado de originais.
- A primeira validação funcional pode começar no Windows, mas o código local e a distribuição são planejados para Windows, macOS e Linux. O Linux inicial será uma distribuição explicitamente testada, não “todo Linux”.

## Componentes e fronteiras

```text
Computador do cliente                         Nuvem Lumen
┌─────────────────────────────┐               ┌──────────────────────────────┐
│ Lumen Desktop               │   HTTPS       │ API FastAPI                  │
│ React/Vite + Tauri/Rust      ├──────────────►│ identidade + autorização     │
│ SQLite: fila e cache local  │◄──────────────┤ catálogo + revisão + busca  │
│ cópia/FFprobe/miniaturas    │               ├──────────┬───────────────────┤
│ originais locais            │               │ fila     │ PostgreSQL        │
└─────────────────────────────┘               │ workers │ + pgvector*       │
                                               └────┬─────┴───────────────────┘
                                                    │ armazenamento de prévias
                                                    └──────────────────────────
* pgvector entra quando a busca semântica for validada.
```

Começar com **monólito modular** na API e workers implantados separadamente. Os módulos podem ser identidade, organizações, captações, acervo, revisão, busca, processamento e cobrança/uso. Isso evita a complexidade inicial de microserviços, mas permite aumentar a capacidade de API e de IA de forma independente. Kubernetes não é requisito do MVP.

## Contas e espaços de trabalho

| Uso | Representação | Compartilhamento |
| --- | --- | --- |
| Pessoa que trabalha sozinha | 1 usuário + 1 espaço de trabalho pessoal | Acervo privado; a própria pessoa é proprietária e editora. |
| Equipe de uma empresa | 1 espaço de trabalho + vários usuários | Membros convidados acessam o mesmo catálogo conforme seu papel. |
| Vários clientes | 1 espaço por cliente/equipe | Acervos, jobs, prévias e limites separados. |
| Freelancer com vários clientes | 1 usuário associado a vários espaços | Troca explícita de espaço; associação a dois espaços **não** mistura os acervos. |

`User` representa a pessoa, `Workspace` representa o acervo/conta e `Membership` liga ambos com um papel. No cadastro, criar um espaço pessoal automaticamente; a pessoa pode convidar membros ou entrar em outros espaços. Plano/cobrança e quotas pertencem ao espaço, não necessariamente ao usuário. Uma captação e cada arquivo pertencem a **um** espaço por vez. Compartilhar ou transferir entre espaços requer ação explícita e autorização, nunca ocorre por causa de um nome de arquivo igual.

A instalação do agente é associada à identidade do usuário e registra quais espaços ele pode usar. Antes de ingerir, o app mostra o espaço ativo; caminhos locais, fila e cache são segregados por espaço para evitar que a mesma máquina envie mídia ao cliente errado.

## Isolamento e segurança entre clientes

1. O servidor valida o usuário e sua associação ao espaço ativo. O `tenant_id` (ID interno do espaço) usado em cada operação vem dessa associação validada; não confiar em um ID enviado pelo desktop sem checagem.
2. Tabelas centrais com dados do cliente têm `tenant_id`. Aplicar autorização na camada de serviço e **Row-Level Security** no PostgreSQL como defesa adicional; testar inclusive usuários/rotinas com privilégio elevado que podem contornar RLS.
3. Busca textual, vetorial, cache, jobs, métricas de uso e auditoria preservam o mesmo escopo. Uma consulta em um espaço nunca pesquisa dados de outro, mesmo quando o usuário pertence aos dois.
4. Objetos de prévia são privados, separados por organização e acessados somente depois de autorização. URLs temporárias, quando usadas, devem ser curtas e restritas ao objeto e à operação.
5. Worker recebe contexto de organização autenticado/assinado pelo serviço e confirma a posse do job antes de ler qualquer dado. Toda operação relevante gera auditoria.
6. Criptografia em trânsito e em repouso, segredos fora do repositório, backup e teste de restauração desde a beta.

## Ingestão e sincronização

- Antes da ingestão, o usuário confirma o espaço de trabalho ativo. O app registra fonte, captação e cada arquivo com ID estável e espaço definido; `C001.MP4` é atributo, não identidade. A cópia do cartão para destino local permanente é verificada antes de marcar ingestão concluída.
- A fila local no SQLite conserva progresso quando a internet cai. Ao reconectar, reenvia operações idempotentes com chave de idempotência, sem duplicar captação/asset.
- Envio em lotes e com limite de banda; dados e prévias necessários à IA são configuráveis e consentidos. O padrão não envia os originais completos.
- A API devolve IDs, estados e sugestões. O app apresenta local sugerido, confiança e evidências por take; “local não identificado” é resultado válido.
- Aprovação altera o **catálogo lógico**, não apaga nem move originais. Uma eventual reorganização física exige operação explícita, verificável e reversível.
- O catálogo pode aparecer para vários membros do mesmo espaço, mas prévia e original têm disponibilidades diferentes. Abrir o original de outro computador requer NAS/servidor de arquivos/armazenamento de originais autorizado. Para o espaço individual, a experiência é a mesma, sem exigir configuração de equipe.

## Escala e custo

- Toda análise pesada entra em fila durável; a API responde rápido com um `job_id` e o desktop acompanha progresso. Workers devem aceitar repetição segura, retries limitados, timeout e fila de falhas.
- Separar filas por tipo de trabalho (metadados/prévias, OCR/áudio/visual, embeddings) e limitar concorrência/uso por organização para evitar que um cliente monopolize a plataforma.
- Limites de tamanho de envio, quantidade de jobs simultâneos, retenção de prévias e orçamento de IA por organização. Medir custo por captação, não apenas usuários ativos.
- API, workers e armazenamento de objetos podem crescer independentemente. Escalar horizontalmente só depois de medir gargalos; evitar microserviços prematuros.
- Objetivo inicial de disponibilidade, tempo máximo de fila e recuperação deve ser definido com dados do piloto, não prometido sem medição.

## Modelo mínimo de autorização

- **Proprietário do espaço:** configura cobrança/plano, membros, dispositivos, políticas, limites e auditoria. No uso individual, é o próprio usuário.
- **Administrador:** administra membros e operações permitidas, sem necessariamente ser o titular da cobrança.
- **Cinegrafista/operador:** ingerir captação e acompanhar cópia/processamento.
- **Editor:** buscar, revisar e aprovar dentro das permissões do espaço.
- **Equipe Lumen:** suporte com acesso temporário e auditado, sem leitura automática de mídia de clientes.

## Distribuição multiplataforma

- UI e contratos de API comuns. O núcleo Rust encapsula diferenças de volumes, caminhos, permissões, ejetar/montar mídia e execução de FFprobe/FFmpeg.
- Builds e testes automatizados em Windows, macOS e Linux; testes manuais com cartões e discos reais em cada SO. Gerar pacotes e atualizações específicos por plataforma.
- macOS: validar Intel e Apple Silicon conforme público-alvo, assinatura/notarização e permissões. Linux: escolher distribuição inicial e validar dependências da WebView e formatos de pacote.
- Não depender de `PATH` do shell para localizar FFprobe/FFmpeg em aplicativo gráfico distribuído; empacotar ou configurar o executável de modo explícito, revisando obrigações de distribuição antes do lançamento.

## Decisões abertas antes da beta pública

1. Quais tipos de prévias/frames/áudio podem sair da máquina e por quanto tempo ficam guardados?
2. O produto terá apenas catálogo central ou um plano pago com armazenamento de originais compartilhados?
3. Qual distribuição Linux, versões de macOS e arquiteturas de CPU serão oficialmente suportadas?
4. Qual provedor de identidade, nuvem, armazenamento de objetos e fila durável atende ao custo e à política de dados?
5. Qual limite por organização para armazenamento de prévias, jobs simultâneos e uso de IA?
6. Quais métricas do piloto definem qualidade mínima de sugestão e custo aceitável por captação?
7. Convites e espaços pessoais estarão no primeiro MVP, ou apenas no primeiro piloto? O **modelo de dados e a autorização** precisam suportar ambos desde o começo, mesmo se a UI de equipe vier depois.

## Referências

- Segurança multiempresa: https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html
- PostgreSQL Row-Level Security: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Celery, tarefas idempotentes e retries: https://docs.celeryq.dev/en/stable/userguide/tasks.html
- Tauri, distribuição por plataforma: https://v2.tauri.app/distribute/
