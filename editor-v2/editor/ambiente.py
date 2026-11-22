"""
Etapa 1 — Verificação do ambiente.

Este arquivo responde: "o computador (ou o Colab) tem tudo o que o
Editor V2 precisa?". Ele verifica:
  1. Sistema operacional
  2. Versão do Python
  3. FFmpeg (programa que corta e exporta vídeo)
  4. GPU (placa de vídeo) — deixa tudo muito mais rápido
  5. faster-whisper (a IA que transcreve a fala)
E no fim cria as pastas entrada/, saida/ e projeto/.

Como rodar:  python -m editor.ambiente
"""

import platform
import shutil
import subprocess
import sys
from pathlib import Path

from editor import config


def _ok(msg):
    """Mostra uma linha de sucesso."""
    print(f"  ✅ {msg}")


def _aviso(msg):
    """Mostra uma linha de aviso (funciona, mas pode melhorar)."""
    print(f"  ⚠️  {msg}")


def _erro(msg):
    """Mostra uma linha de erro (precisa resolver antes de continuar)."""
    print(f"  ❌ {msg}")


def esta_no_colab():
    """Retorna True se o código está rodando dentro do Google Colab."""
    return "google.colab" in sys.modules


def verificar_sistema():
    """Mostra qual sistema operacional está sendo usado."""
    nome = platform.system()  # "Windows", "Darwin" (Mac) ou "Linux"
    if nome == "Darwin":
        nome = "Mac (macOS)"
    onde = " (Google Colab)" if esta_no_colab() else ""
    _ok(f"Sistema: {nome}{onde}")
    return True


def verificar_python():
    """O Editor V2 precisa de Python 3.9 ou mais novo."""
    v = sys.version_info
    texto = f"{v.major}.{v.minor}.{v.micro}"
    if v >= (3, 9):
        _ok(f"Python {texto}")
        return True
    _erro(f"Python {texto} é antigo demais. Instale o Python 3.9 ou mais novo.")
    return False


def verificar_ffmpeg():
    """Confere se os programas ffmpeg e ffprobe estão instalados."""
    tudo_certo = True
    for programa in ("ffmpeg", "ffprobe"):
        if shutil.which(programa) is None:
            _erro(f"{programa} não encontrado.")
            tudo_certo = False
    if not tudo_certo:
        print("     No Colab: rode  !apt-get install -y ffmpeg")
        return False

    # Pega a primeira linha da versão, ex.: "ffmpeg version 6.1.1 ..."
    saida = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
    versao = saida.stdout.splitlines()[0].split(" ")[2] if saida.stdout else "?"
    _ok(f"FFmpeg {versao}")
    return True


def detectar_gpu():
    """
    Procura uma placa de vídeo NVIDIA.
    Retorna o nome da GPU (ex.: "Tesla T4") ou None se não houver.
    """
    if shutil.which("nvidia-smi") is None:
        return None
    saida = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
        capture_output=True, text=True,
    )
    linha = saida.stdout.strip().splitlines()
    return linha[0] if saida.returncode == 0 and linha else None


def verificar_gpu():
    """Mostra se há GPU. Sem GPU funciona, mas fica bem mais lento."""
    gpu = detectar_gpu()
    if gpu:
        _ok(f"GPU encontrada: {gpu}")
        return True
    _aviso("Nenhuma GPU encontrada. Vai funcionar, mas bem mais devagar.")
    if esta_no_colab():
        print("     No Colab: menu Ambiente de execução > Alterar o tipo de")
        print("     ambiente de execução > escolha 'GPU T4' e rode tudo de novo.")
    return True  # não é um erro grave


def verificar_whisper():
    """Confere se a biblioteca faster-whisper está instalada."""
    try:
        import faster_whisper  # noqa: F401  (só testamos se existe)
        _ok(f"faster-whisper {faster_whisper.__version__}")
        return True
    except ImportError:
        _erro("faster-whisper não está instalado.")
        print("     Rode:  pip install -r requirements.txt")
        return False


def criar_pastas(base=None):
    """
    Cria as pastas entrada/, saida/ e projeto/ (se ainda não existirem).
    Nunca apaga nada que já esteja lá dentro.
    """
    base = Path(base or config.PASTA_BASE)
    for nome in config.NOMES_PASTAS:
        (base / nome).mkdir(parents=True, exist_ok=True)
    _ok(f"Pastas prontas em: {base}")
    for nome in config.NOMES_PASTAS:
        print(f"       📁 {nome}/")
    return True


def verificar_tudo(base=None):
    """Roda todas as verificações e mostra um resumo no final."""
    print("\n🔎 Verificando o ambiente do Editor V2...\n")
    resultados = [
        verificar_sistema(),
        verificar_python(),
        verificar_ffmpeg(),
        verificar_gpu(),
        verificar_whisper(),
        criar_pastas(base),
    ]
    print()
    if all(resultados):
        print("🎉 Tudo pronto! Pode seguir para a Etapa 2 (Transcrição).\n")
    else:
        print("🛠️  Resolva os itens com ❌ acima e rode a verificação de novo.\n")
    return all(resultados)


# Permite rodar direto pelo terminal: python -m editor.ambiente
if __name__ == "__main__":
    ok = verificar_tudo(sys.argv[1] if len(sys.argv) > 1 else None)
    sys.exit(0 if ok else 1)
