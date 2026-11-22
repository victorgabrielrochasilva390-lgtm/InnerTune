"""
Configurações do Editor V2.

Aqui ficam as SUAS preferências. Se quiser mudar algo (por exemplo,
o tempo mínimo de silêncio), é só trocar o número aqui. Nenhum outro
arquivo precisa ser alterado.
"""

from pathlib import Path

# ---------------------------------------------------------------------------
# Pastas do projeto
# ---------------------------------------------------------------------------
# Pasta principal. No Google Colab ela fica dentro do seu Google Drive,
# assim os vídeos e resultados não somem quando o Colab desconecta.
# (O caderno EditorV2.ipynb troca este valor automaticamente.)
PASTA_BASE = Path(__file__).resolve().parent.parent

# entrada/  -> onde você coloca o vídeo ORIGINAL (nunca é alterado)
# saida/    -> onde aparecem os vídeos prontos (sempre arquivos novos)
# projeto/  -> arquivos de trabalho: transcricao.json, plano.json, legendas .ass
NOMES_PASTAS = ("entrada", "saida", "projeto")

# ---------------------------------------------------------------------------
# Transcrição (Etapa 2)
# ---------------------------------------------------------------------------
IDIOMA = "pt"              # português do Brasil
MODELO_WHISPER_GPU = "large-v3"   # melhor qualidade, usado quando há GPU
MODELO_WHISPER_CPU = "small"      # mais leve, usado quando NÃO há GPU

# ---------------------------------------------------------------------------
# Legendas (Etapa 3) — respostas do questionário inicial
# ---------------------------------------------------------------------------
LEGENDA_POSICAO = "embaixo"        # "embaixo" ou "centro"
LEGENDA_COR_DESTAQUE = "#FFD23F"   # amarelo (mesmo tom do Editor V1)
LEGENDA_PALAVRAS_POR_VEZ = 3       # de 1 a 3 palavras na tela

# ---------------------------------------------------------------------------
# Cortes (Etapa 4) — respostas do questionário inicial
# ---------------------------------------------------------------------------
SILENCIO_MINIMO = 0.6   # segundos: silêncios maiores que isso viram corte
MARGEM_CORTE = 0.15     # segundos: folga mantida antes/depois da fala
VICIOS_DE_FALA = ("éé", "é é", "ééé", "hum", "humm", "hm", "ahn", "ah", "né")
