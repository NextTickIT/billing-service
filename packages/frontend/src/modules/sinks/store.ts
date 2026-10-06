import { defineStore } from 'pinia';
import { ref } from 'vue';
import { SinkKind } from '@billing-service/shared';
import type {
  SendPulseSinkView,
  SinkView,
  UpdateSinkRequest,
  SinkFlow,
} from '@billing-service/shared';

import { getSinks, updateSink, getSinkFlows } from './api.js';

// `sinks` holds one row per kind (SendPulse and email). This page edits the SendPulse
// one, so select it by kind: position would quietly hand over whichever row sorted
// first, and saving would then overwrite the other sink's secret.
function pickSendpulse(sinks: SinkView[]): SendPulseSinkView | null {
  return sinks.find((s) => s.kind === SinkKind.SendPulse) ?? null;
}

export const useSinksStore = defineStore('sinks', () => {
  const sink = ref<SendPulseSinkView | null>(null);
  const flows = ref<SinkFlow[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  // A 422 from the flows endpoint means the stored token is missing or rejected;
  // the page keeps the selectors disabled and shows a "check the token" hint.
  const flowsError = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      sink.value = pickSendpulse(await getSinks());
      if (sink.value?.auth.hasToken) await loadFlows();
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
    } finally {
      loading.value = false;
    }
  }

  async function loadFlows(): Promise<void> {
    if (!sink.value?.auth.hasToken) return;
    flowsError.value = false;
    try {
      flows.value = await getSinkFlows();
    } catch (e) {
      flows.value = [];
      flowsError.value = true;
      error.value = e instanceof Error ? e.message : 'Error';
    }
  }

  async function save(patch: UpdateSinkRequest): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      sink.value = pickSendpulse([await updateSink(patch)]);
      if (sink.value?.auth.hasToken) await loadFlows();
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Error';
      return false;
    } finally {
      saving.value = false;
    }
  }

  return {
    sink,
    flows,
    loading,
    saving,
    error,
    flowsError,
    load,
    save,
    loadFlows,
  };
});
