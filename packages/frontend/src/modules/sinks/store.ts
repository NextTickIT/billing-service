import { defineStore } from 'pinia';
import { ref } from 'vue';
import { SinkKind } from '@billing-service/shared';
import type {
  CrmSinkView,
  SendPulseSinkView,
  SinkView,
  UpdateSinkRequest,
  SinkFlow,
} from '@billing-service/shared';

import { getSinks, updateSink, getSinkFlows } from './api.js';

// Picked by KIND, never by position: the list is ordered by the numeric kind, and indexing
// into it would silently hand the CRM row to the SendPulse form the day a kind is added
// or removed. Two narrowing predicates rather than one generic helper, so each form gets a
// view already narrowed to its own config shape.
const isSendPulse = (s: SinkView): s is SendPulseSinkView =>
  s.kind === SinkKind.SendPulse;

const isCrm = (s: SinkView): s is CrmSinkView => s.kind === SinkKind.Crm;

const message = (e: unknown): string =>
  e instanceof Error ? e.message : 'Error';

/**
 * One slice per sink, because the two sinks are genuinely independent: they have different
 * config shapes, they save to different rows, and one failing to save must not revert or
 * blank the other. The store below is then just composition plus the shared initial load.
 */
const useSendPulseSlice = () => {
  const sink = ref<SendPulseSinkView | null>(null);
  const flows = ref<SinkFlow[]>([]);
  const saving = ref(false);
  const error = ref<string | null>(null);
  // A 422 from the flows endpoint means the stored token is missing or rejected;
  // the page keeps the selectors disabled and shows a "check the token" hint.
  const flowsError = ref(false);

  async function loadFlows(): Promise<void> {
    if (!sink.value?.auth.hasToken) return;
    flowsError.value = false;
    try {
      flows.value = await getSinkFlows();
    } catch (e) {
      flows.value = [];
      flowsError.value = true;
      error.value = message(e);
    }
  }

  async function save(patch: UpdateSinkRequest): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      const updated = await updateSink('sendpulse', patch);
      if (updated.kind === SinkKind.SendPulse) sink.value = updated;
      if (updated.auth.hasToken) await loadFlows();
      return true;
    } catch (e) {
      error.value = message(e);
      return false;
    } finally {
      saving.value = false;
    }
  }

  return { sink, flows, saving, error, flowsError, save, loadFlows };
};

/** The CRM feed's own slice: its row, its save, its error. */
const useCrmSlice = () => {
  const crm = ref<CrmSinkView | null>(null);
  const savingCrm = ref(false);
  const crmError = ref<string | null>(null);

  async function saveCrm(patch: UpdateSinkRequest): Promise<boolean> {
    savingCrm.value = true;
    crmError.value = null;
    try {
      const updated = await updateSink('crm', patch);
      if (updated.kind === SinkKind.Crm) crm.value = updated;
      return true;
    } catch (e) {
      crmError.value = message(e);
      return false;
    } finally {
      savingCrm.value = false;
    }
  }

  return { crm, savingCrm, crmError, saveCrm };
};

export const useSinksStore = defineStore('sinks', () => {
  const sp = useSendPulseSlice();
  const crmSlice = useCrmSlice();
  const loading = ref(false);

  // One GET returns every sink, so the initial load is shared rather than per-slice.
  async function load(): Promise<void> {
    loading.value = true;
    sp.error.value = null;
    try {
      const sinks = await getSinks();
      sp.sink.value = sinks.find(isSendPulse) ?? null;
      crmSlice.crm.value = sinks.find(isCrm) ?? null;
      if (sp.sink.value?.auth.hasToken) await sp.loadFlows();
    } catch (e) {
      sp.error.value = message(e);
    } finally {
      loading.value = false;
    }
  }

  return { ...sp, ...crmSlice, loading, load };
});
