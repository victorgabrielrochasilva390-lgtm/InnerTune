# 🎬 Editor V2

Editor de vídeo com IA, grátis, que roda no **Google Colab** (pelo navegador do celular).

Você entrega um vídeo e recebe:
1. Legendas palavra por palavra, queimadas no vídeo.
2. Cortes automáticos (silêncios, "éé", "hum", repetições), cada um com o **motivo**.
3. Um plano de edição (`plano.json`) para revisar antes de exportar.

## Como abrir no celular

1. Abra este link no Chrome do Android:
   https://colab.research.google.com/github/victorgabrielrochasilva390-lgtm/InnerTune/blob/claude/editor-v2-spec-us964d/editor-v2/EditorV2.ipynb
2. Entre com a sua conta Google.
3. Menu **⋮ → Ambiente de execução → Alterar o tipo de ambiente de execução → GPU T4 → Salvar**.
4. Toque no ▶️ de cada bloco, um por vez, de cima para baixo.

## Pastas (ficam no seu Google Drive, em `Meu Drive/EditorV2`)

| Pasta      | Para quê                                                      |
|------------|---------------------------------------------------------------|
| `entrada/` | Coloque aqui o vídeo **original**. Ele nunca é alterado.      |
| `saida/`   | Vídeos prontos. Sempre arquivos **novos**.                    |
| `projeto/` | Arquivos de trabalho: transcrição, plano, legendas.           |

## Arquivos do código

| Arquivo                | O que faz                                              |
|------------------------|--------------------------------------------------------|
| `EditorV2.ipynb`       | O caderno do Colab, com os botões ▶️.                  |
| `editor/config.py`     | Suas preferências (silêncio, cor da legenda, etc.).    |
| `editor/ambiente.py`   | Etapa 1: confere se tudo está instalado.               |
| `editor-v1.html`       | Editor V1, usado como referência visual na Etapa 6.    |

## Etapas

- [x] 1. Ambiente
- [ ] 2. Transcrição
- [ ] 3. Legendas
- [ ] 4. Cortes com motivo
- [ ] 5. Renderização
- [ ] 6. Interface
- [ ] 7. Estilo de referência (opcional)
