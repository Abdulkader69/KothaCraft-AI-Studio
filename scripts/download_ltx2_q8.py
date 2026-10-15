#!/usr/bin/env python3
"""
Selectively download LTX-2.3 MLX Q8 distilled weights and Gemma-3 12B 4-bit text encoder
directly to external drive (/Volumes/Mac Drive/faceless-pipeline).
"""

import os
import sys
import time
from pathlib import Path

ROOT = Path("/Volumes/Mac Drive/faceless-pipeline")
MODEL_DIR = ROOT / "models" / "ltx-2.3-mlx-q8"
HF_CACHE = ROOT / ".hf_cache"

os.environ["HF_HOME"] = str(HF_CACHE)
os.environ["HF_HUB_DISABLE_XET"] = "1"
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"

from huggingface_hub import hf_hub_download, snapshot_download

LTX2_REPO = "dgrauet/ltx-2.3-mlx-q8"
FILES_TO_DOWNLOAD = [
    # Configs
    "config.json",
    "quantize_config.json",
    "split_model.json",
    "embedded_config.json",
    "spatial_upscaler_x2_v1_1_config.json",
    # Model weights
    "audio_vae.safetensors",
    "vocoder.safetensors",
    "vae_decoder.safetensors",
    "vae_encoder.safetensors",
    "spatial_upscaler_x2_v1_1.safetensors",
    "connector.safetensors",
    "transformer-distilled-1.1.safetensors",
]

def download_ltx_files():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    HF_CACHE.mkdir(parents=True, exist_ok=True)
    print(f"Downloading LTX-2.3 Q8 weights to: {MODEL_DIR}")
    print(f"HF cache directory: {HF_CACHE}")

    for idx, filename in enumerate(FILES_TO_DOWNLOAD, 1):
        target = MODEL_DIR / filename
        if target.exists() and target.stat().st_size > 0:
            print(f"[{idx}/{len(FILES_TO_DOWNLOAD)}] {filename} already exists ({target.stat().st_size / 1024**2:.1f} MB), skipping.")
            continue

        print(f"\n[{idx}/{len(FILES_TO_DOWNLOAD)}] Downloading {filename}...")
        attempts = 0
        while attempts < 10:
            try:
                hf_hub_download(
                    repo_id=LTX2_REPO,
                    filename=filename,
                    local_dir=str(MODEL_DIR),
                )
                print(f"✓ Downloaded {filename} ({target.stat().st_size / 1024**2:.1f} MB)")
                break
            except Exception as e:
                attempts += 1
                print(f"Error downloading {filename} (attempt {attempts}/10): {e}")
                time.sleep(5)
        else:
            print(f"Failed to download {filename} after 10 attempts!")
            sys.exit(1)

    print("\nAll LTX-2.3 Q8 files downloaded successfully!")

def download_gemma_encoder():
    print("\nDownloading mlx-community/gemma-3-12b-it-4bit text encoder...")
    attempts = 0
    while attempts < 10:
        try:
            snapshot_download(
                repo_id="mlx-community/gemma-3-12b-it-4bit",
                local_dir_use_symlinks=False,
            )
            print("✓ Gemma 3 text encoder downloaded successfully!")
            break
        except Exception as e:
            attempts += 1
            print(f"Error downloading Gemma 3 (attempt {attempts}/10): {e}")
            time.sleep(5)
    else:
        print("Failed to download Gemma 3 text encoder after 10 attempts!")
        sys.exit(1)

if __name__ == "__main__":
    download_ltx_files()
    download_gemma_encoder()
    print("\nSetup complete! You can now run LTX-2 Q8 inference.")

