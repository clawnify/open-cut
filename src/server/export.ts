// Export pipeline for footage edit projects.
//
// An export resolves the EDL's "asset:<id>" references to staged sources on
// the managed edit service, runs the edit there, and copies the MP4 back into
// this app's storage. Staging is a cache: each library asset is uploaded to
// the service once and reused across exports; staged copies expire after ~30
// days and are re-staged transparently. All media moves as fixed-length
// streams — nothing is buffered in the worker.

import { get, run } from "./db";
import { getUpload, putUpload } from "./uploads";
import { collectAssetIds, substituteAssetSrcs, type Edl, type EdlInvalid } from "./edl";

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";
// Re-stage when the staged copy expires within this window — an export must
// never race the expiry.
const RESTAGE_MARGIN_MS = 6 * 60 * 60 * 1000;

export interface ExportConfig {
  servicesUrl?: string;
  token: string;
}

interface AssetRow {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
  service_key: string | null;
  service_key_expires_at: string | null;
}

export interface ExportFailure {
  error: string;
  detail: string;
  path?: string;
}

/**
 * Resolve every "asset:<id>" in the EDL to a fresh staged source, re-staging
 * from this app's storage where needed. Returns the resolved document or a
 * failure the caller can surface directly.
 */
export async function resolveEdlSources(
  edl: Edl,
  cfg: ExportConfig,
): Promise<{ edl: Edl } | { failure: ExportFailure }> {
  const staged = new Map<string, string>();

  for (const assetId of collectAssetIds(edl)) {
    const asset = await get<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
    if (!asset) {
      return {
        failure: {
          error: "asset_not_found",
          detail: `no media-library asset with id "${assetId}" — list assets with GET /api/assets`,
        },
      };
    }

    const fresh =
      asset.service_key &&
      asset.service_key_expires_at &&
      Date.parse(asset.service_key_expires_at) > Date.now() + RESTAGE_MARGIN_MS;

    let key = asset.service_key;
    if (!fresh) {
      const stagedFile = await stageAsset(asset, cfg);
      if ("failure" in stagedFile) return stagedFile;
      key = stagedFile.key;
    }
    staged.set(assetId, `file:${key}`);
  }

  return { edl: substituteAssetSrcs(edl, (id) => staged.get(id)!) };
}

/** Stream one asset from this app's storage to the edit service's staging. */
async function stageAsset(
  asset: AssetRow,
  cfg: ExportConfig,
): Promise<{ key: string } | { failure: ExportFailure }> {
  const obj = await getUpload(asset.key);
  if (!obj) {
    return {
      failure: {
        error: "asset_missing",
        detail: `asset "${asset.name}" (${asset.id}) has no stored file — re-upload it`,
      },
    };
  }

  // Fixed-length stream so the upload carries a Content-Length end to end.
  const fixed = new FixedLengthStream(obj.size);
  const pipe = obj.data.pipeTo(fixed.writable);
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": obj.contentType,
      "Content-Length": String(obj.size),
    },
    body: fixed.readable,
  });
  await pipe;

  const json = (await res.json().catch(() => null)) as
    | { key?: string; expires_at?: string; error?: string; detail?: string }
    | null;
  if (res.status !== 201 || !json?.key) {
    return {
      failure: {
        error: json?.error ?? "staging_failed",
        detail: `could not stage "${asset.name}": ${json?.detail ?? `service returned ${res.status}`}`,
      },
    };
  }

  await run(
    "UPDATE assets SET service_key = ?, service_key_expires_at = ? WHERE id = ?",
    [json.key, json.expires_at ?? null, asset.id],
  );
  return { key: json.key };
}

export interface EditResult {
  url: string;
  duration: number;
  size: number;
}

/** Run the resolved EDL on the managed edit service. */
export async function runEdit(
  edl: Edl,
  opts: { quality: string; filename: string },
  cfg: ExportConfig,
): Promise<{ result: EditResult } | { failure: ExportFailure }> {
  const res = await fetch(`${cfg.servicesUrl || DEFAULT_SERVICES_URL}/video/edit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ edl, quality: opts.quality, filename: opts.filename }),
  });
  const json = (await res.json().catch(() => null)) as
    | (Partial<EditResult> & Partial<EdlInvalid> & { error?: string })
    | null;

  if (res.status !== 200 || !json?.url) {
    return {
      failure: {
        error: json?.error ?? "edit_failed",
        detail: json?.detail ?? `edit service returned ${res.status}`,
        ...(json?.path ? { path: json.path } : {}),
      },
    };
  }
  return { result: { url: json.url, duration: json.duration ?? 0, size: json.size ?? 0 } };
}

/** Copy the finished MP4 into this app's storage; returns the storage key. */
export async function copyOutput(result: EditResult, key: string): Promise<void> {
  const res = await fetch(result.url);
  if (!res.ok || !res.body) throw new Error(`output download failed (${res.status})`);
  const size = Number(res.headers.get("content-length") ?? result.size);
  const fixed = new FixedLengthStream(size);
  const pipe = res.body.pipeTo(fixed.writable);
  await putUpload(key, fixed.readable, "video/mp4");
  await pipe;
}
