// Pinned toolchain for the plugin-managed GigaAM environment. Every value
// here feeds INSTALL_SPEC_ID, so changing one makes existing installs rebuild
// their Python environment on the next start.
import { createHash } from "node:crypto";

export const UV_VERSION = "0.13.0";
export const PYTHON_VERSION = "3.12";
export const GIGAAM_COMMIT = "7447938d791c4f3e643386ee22c33777004293a5";

export const TORCH_PACKAGES = ["torch==2.14.1", "torchaudio==2.11.0"] as const;
export const SERVER_PACKAGES = [
  `gigaam @ https://github.com/salute-developers/GigaAM/archive/${GIGAAM_COMMIT}.tar.gz`,
  "fastapi==0.143.0",
  "uvicorn==0.54.0",
  "python-multipart==0.0.32",
  "imageio-ffmpeg==0.6.0",
] as const;

/** CPU-only wheels keep a Linux install near 1 GB instead of several GB of CUDA. */
const PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";

interface UvAsset {
  readonly target: string;
  readonly sha256: string;
}

// SHA-256 sums from the uv release's .sha256 files, checked after download.
const UV_ASSETS: Readonly<Record<string, UvAsset>> = {
  "linux-x64": {
    target: "x86_64-unknown-linux-musl",
    sha256: "b0828fc4cdc47d65951e94b5f0a15a5364420e8dcd88723f3b21e7a2eb30bbc3",
  },
  "linux-arm64": {
    target: "aarch64-unknown-linux-musl",
    sha256: "281ca6cf43f4e26e35474839ad4861be86de42af2682f74134460f5b2071b96d",
  },
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6",
  },
};

export type PlatformSupport =
  | {
      readonly supported: true;
      readonly uv: UvAsset & { readonly url: string };
      readonly torchIndexArgs: readonly string[];
    }
  | { readonly supported: false; readonly reason: string };

export function platformSupport(
  platform: NodeJS.Platform,
  arch: string,
): PlatformSupport {
  const asset = UV_ASSETS[`${platform}-${arch}`];
  if (asset === undefined) {
    const reason =
      platform === "darwin" && arch === "x64"
        ? "Intel Macs are not supported: PyTorch no longer ships wheels for them"
        : `${platform}-${arch} is not supported; use Linux (x64, arm64) or macOS on Apple silicon, or point the "GigaAM server URL" setting at a server elsewhere`;
    return { supported: false, reason };
  }
  return {
    supported: true,
    uv: {
      ...asset,
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${asset.target}.tar.gz`,
    },
    torchIndexArgs: platform === "linux" ? ["--index-url", PYTORCH_CPU_INDEX] : [],
  };
}

export const INSTALL_SPEC_ID = createHash("sha256")
  .update(
    JSON.stringify({
      uv: UV_VERSION,
      python: PYTHON_VERSION,
      torch: TORCH_PACKAGES,
      server: SERVER_PACKAGES,
    }),
  )
  .digest("hex")
  .slice(0, 16);
