# Pickle Rick para opencode 🥒

[English](README.md) · **Português (Brasil)**

Port do [pickle-rick-extension](https://github.com/galdawave/pickle-rick-extension) (Gemini CLI) para o **opencode**: o loop autônomo do Ralph Wiggum + o ciclo PRD → tickets → pesquisa → plano → implementação → refactor, com o Rick no comando e os Mortys como workers.

Funciona com **qualquer modelo/provedor** configurado no opencode — o loop re-prompt a própria sessão, então herda o agente e o modelo que você já está usando (não há modelo embutido nem dependência do Gemini).

> Escrito para a **API v2 de plugins** do opencode (`Plugin.define` + `setup(ctx)`, pacote `@opencode/plugin`), testado no **opencode v2.1.3**. O motor (`core.ts`) é puro e independente da API; só o shim fala com o host.

## Instalação

```sh
./install.sh /caminho/do/projeto   # só nesse projeto
./install.sh --global              # em ~/.config/opencode
./install.sh --uninstall [PROJETO] # remove só os arquivos deste pacote
./install.sh --help                # ajuda
```

Reinicie o opencode e rode `/help-pickle`. Cada estado/artefato fica em `.pickle-rick/sessions/<sessão>/` dentro do projeto (o instalador adiciona `.pickle-rick/` ao `.gitignore`; no modo `--global` esse passo não se aplica).

Instalação manual: copie o conteúdo de `.opencode/` para `.opencode/` do projeto (ou `~/.config/opencode/`), mantendo a estrutura (`plugins/`, `pickle-rick/`, `commands/`, `agents/`, `skills/`).

## Uso

| Comando | O que faz |
|---|---|
| `/pickle "tarefa" [--max-iterations N] [--max-time MIN] [--max-tokens N\|off] [--worker-timeout SEG] [--morty-model PROVEDOR/MODELO] [--name SLUG] [--completion-promise TEXTO] [--allow-dirty] [--force] [--resume [PATH]]` | Inicia o loop (padrão: 5 iterações, 60 min, 2M tokens, 20 min por Morty, promise `DONE`) |
| `/pickle-prd "ideia"` | Redige o PRD interativamente; depois `/pickle --resume` |
| `/eat-pickle` | Cancela o loop |
| `/add-to-pickle-jar "tarefa"` | Põe uma tarefa na fila (o "Jar") |
| `/pickle-jar-list` | Lista as tarefas na fila |
| `/pickle-jar-open` | Roda a fila, um loop após o outro |
| `/help-pickle` | Cola de comandos |

Esc interrompe: o loop **para** em vez de re-promptar. Iniciar um segundo loop com um ativo é recusado; use `--resume` para continuar ou `--force` para substituir. Working tree suja também é recusada, a menos que você passe `--allow-dirty`.

Tickets com `Status: done` no cabeçalho são pulados automaticamente: `pickle_status` mostra `Tickets: feitos/total · next <ticket>`, e `pickle_send_to_morty` com ticket vazio pega o próximo aberto.

## Orçamento de tokens

Cada loop conta tokens por tarefa — `input + output + reasoning`, com cache read/write à parte — e soma o que os Mortys gastam nas sessões-filhas.

```sh
/pickle "refatorar auth" --max-tokens 500k   # 500_000 tokens
/pickle "refatorar auth" --max-tokens 1.5m   # 1_500_000
/pickle "refatorar auth" --max-tokens off    # sem limite
```

- Teto padrão: **2.000.000 de tokens** por loop.
- Ao atingir o teto, o loop para com `stopReason: "max-tokens"` em vez de iniciar outra iteração.
- Em **80%** o loop avisa uma vez (toast + marca em todo prompt), para o modelo fechar o ticket em mãos.
- `pickle_status` mostra `Tokens: usado / teto (porcentagem) · $custo`, o último turno, o total dos Mortys e uma linha `Burn:` com as fases que mais gastaram. O toast `🥒 Done` traz tokens e dólares.
- Todo prompt do loop inclui o orçamento restante, então o modelo sabe quanto falta e é instruído a evitar leituras redundantes e despejo de logs.
- O teto vale para o loop inteiro, incluindo os Mortys: `pickle_send_to_morty` se recusa a spawnar quando o orçamento acabou.
- `--morty-model provedor/modelo` roda os workers em outro modelo (mais barato); o padrão é herdar o modelo do pai.

## Sessões e limpeza

- `pickle_sessions` lista todas as sessões com estado, fase e uso de tokens.
- `pickle_clean` (tool, padrão 7 dias) apaga sessões **finalizadas** mais velhas que N dias; loop ativo nunca é removido.
- `pickle_status` marca um loop ativo como `STALE` após 15 minutos sem heartbeat — o processo provavelmente morreu. Reinicie com `--force` ou `--resume`.

## Como o Gemini virou opencode

| Gemini CLI (original) | opencode (este port) |
|---|---|
| Hook `AfterAgent` que bloqueia a saída | Plugin v2 escutando o fim do turno (`session.execution.succeeded`) e chamando `ctx.session.prompt()` |
| `commands/*.toml` | `.opencode/commands/*.md` (o `$ARGUMENTS` vai cru para a tool `pickle_start`, que faz o parse dos flags em código) |
| `skills/*` (`activate_skill`) | `.opencode/skills/*/SKILL.md` (tool nativa `skill`) |
| `GEMINI.md` (persona) | skill `load-pickle-persona` + regras reinjetadas em todo prompt do loop |
| Scripts `get_session.sh` / `update-state.js` | tools `pickle_status` / `pickle_set_phase` |
| `/send-to-morty` (processo gemini separado) | tool `pickle_send_to_morty`: sessão-filha com o agente `morty`, o modelo do pai, timeout e abort, e o uso de tokens da filha no relatório |
| `sessions/` em `~/.gemini/extensions/…` + `includeDirectories` | `.pickle-rick/` no projeto (sem configuração extra) |

Detalhes que fiz de propósito:
- **Evento de fim de turno traduzido**: no v2.1.x o opencode **não emite mais `session.idle`**; ele emite `session.execution.succeeded` / `.failed` / `.interrupted`. O shim traduz esses três (mais `session.error` e `session.deleted`) para o formato que o motor já entende. O payload vem em `.data`, não em `.properties`.
- **Dedupe**: o loop só avança quando aparece uma mensagem de assistente *nova e concluída* (`time.completed`), então eventos repetidos não disparam iterações extras.
- **Preserva agente e modelo**: no v2 a sessão retém o agente/modelo entre prompts; o re-prompt mantém exatamente o que você estava usando. As sessões do Morty são criadas com o modelo do pai e o agente `morty`.
- **Contabilidade de tokens**: o uso é lido de cada mensagem de assistente (`tokens`) e somado desde o início do loop; o orçamento é checado antes do próximo re-prompt.
- **`<promise>` só vale na última mensagem** e precisa bater com o texto configurado.
- **Compactação**: o estado do loop é injetado no resumo via `ctx.session.hook("compaction", …)`.

## Por que precisa de sessão persistente

O loop só avança quando o turno termina e o evento de execução chega ao plugin. Em **sessão interativa (TUI)** isso é o fluxo normal. Em `opencode run` de turno único, o processo pode encerrar antes que o evento seja entregue — use a TUI para o loop autônomo.

## Segurança (leia)

O loop executa código e shell sozinho. Rode em um branch/worktree ou sandbox e **bloqueie o push**. Exemplo de `opencode.jsonc` na forma **v2** (`permissions` como lista de regras, ação `shell`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" },
    { "action": "shell", "resource": "git diff *", "effect": "allow" },
    { "action": "shell", "resource": "git push *", "effect": "deny" }
  ]
}
```

A última regra que casa vence. No v1 os nomes eram `permission`, `bash` e `task`; no v2 são `permissions`, `shell` e `subagent`. Os Mortys rodam em sessões-filhas e também passam por essas regras; se o opencode pedir aprovação, o loop espera você.

## Solução de problemas

| Sintoma | Correção |
|---|---|
| O loop nunca dispara de novo | Precisa de sessão persistente (TUI). `opencode run` de turno único pode encerrar antes do evento. |
| `pickle_status` mostra `STALE` | O processo morreu no meio. `/pickle --resume` continua, `--force` substitui. |
| `A loop is already running` | Use `/pickle --resume` (continuar) ou `--force` (substituir). |
| `Working tree is dirty` | Commite/dê stash, ou inicie com `--allow-dirty`. |
| Morty diz que o ticket não existe | Crie arquivos em `tickets/` ou passe o id; tickets com `Status: done` são recusados. |
| Tools somem depois de instalar | Reinicie o opencode; o host descobre plugins na inicialização. |
| Desinstalar deixou outros arquivos | Ele só remove os arquivos deste pacote; outros plugins/agents ficam. |

## Testes e limites do que foi verificado

- `node --experimental-strip-types --test test/core.test.ts test/adapter.test.ts` — **37 testes**: 29 do motor (parse, tokens/custo, parada por orçamento, aviso de 80%, loop até a promise, max-iterations/max-time, idle duplicado, interrupção, tickets, Jar, sessões/limpeza, detecção de stale, override de modelo do Morty, timeout e uso) e 8 do adaptador (polling, turnos só de tool call, mapeamento de mensagens, create/modelo, interrupt) contra **mocks**, sem precisar do host.
- **Testado dentro do opencode real** (v2.1.3): loop fim-a-fim via servidor persistente com `opencode/deepseek-v4.1-flash-free` → o evento de fim de turno disparou, o motor re-promptou e gravou `stopReason:"completed"` com o toast `🥒 Done`. Interrupção grava `stopReason:"failed: aborted"`.
- Orçamento de tokens (v2.1.3, ao vivo): `--max-tokens 1` parou o loop com `stopReason:"max-tokens"` depois de 4.884 tokens, e o `pickle_status` reportou o mesmo número.
- Herança do Morty (v2.1.3, ao vivo): a sessão-filha ficou com `agent: "morty"` e o modelo do pai (`opencode/glm-5.3-flash-free`); o relatório terminou com `(child used 38.179 tokens · 126.080 cache read)`.
- Ferramentas registradas e executando no host: `pickle_start`, `pickle_stop`, `pickle_status`, `pickle_set_phase`, `pickle_init_prd`, `pickle_jar_add`, `pickle_jar_list`, `pickle_jar_open`, `pickle_sessions`, `pickle_clean`, `pickle_send_to_morty`.
- Compatível com qualquer modelo do opencode; o teste usou um modelo free só para não gastar créditos.
- Os textos das skills são originais, no mesmo espírito das do repo; as do repo original também podem ser copiadas para `.opencode/skills/` (mesmo formato `SKILL.md`), trocando `run_shell_command`/`activate_skill` e os scripts do Gemini pelas tools acima.
