"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
let cache = null;
let inflight = null;

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  for (const model of models || []) {
    if (!model.caps) continue;
    if (model.fullModel) byFull[model.fullModel] = model.caps;
    if (model.routedModel) byFull[model.routedModel] = model.caps;
    if (model.model) byId[model.model] = model.caps;
  }
  return { byFull, byId };
}

function loadModelCaps() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/models")
    .then(async (response) => {
      if (!response.ok) throw new Error(`models ${response.status}`);
      const data = await response.json();
      cache = buildMaps(data.models);
      return cache;
    })
    .catch(() => ({ byFull: {}, byId: {} }))
    .finally(() => { inflight = null; });
  return inflight;
}

function resolveCaps(byFull, byId, key) {
  if (!key) return null;
  if (byFull[key]) return byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (byId[bare]) return byId[bare];
  const provider = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const capabilities = getCapabilitiesForModel(provider, bare);
  return {
    vision: capabilities.vision,
    search: capabilities.search,
    reasoning: capabilities.reasoning,
    contextWindow: capabilities.contextWindow,
    maxOutput: capabilities.maxOutput,
  };
}

export function useModelCaps() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});

  useEffect(() => {
    if (cache) {
      setByFull(cache.byFull);
      setById(cache.byId);
      return;
    }
    let alive = true;
    loadModelCaps().then((maps) => {
      if (alive) {
        setByFull(maps.byFull);
        setById(maps.byId);
      }
    });
    return () => { alive = false; };
  }, []);

  const getCaps = useCallback(
    (key) => resolveCaps(byFull, byId, key),
    [byFull, byId],
  );

  return { getCaps };
}
