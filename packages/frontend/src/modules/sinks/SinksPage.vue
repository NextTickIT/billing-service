<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { EVENT_NAMES, AuthKind } from '@billing-service/shared';
import type {
  EventName,
  UpdateSinkRequest,
  SinkFlowMap,
} from '@billing-service/shared';
import { useSinksStore } from './store.js';
import BasePanel from '@/components/BasePanel.vue';
import BaseInput from '@/components/BaseInput.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSpinner from '@/components/BaseSpinner.vue';
import BaseCombobox from '@/components/BaseCombobox.vue';

// Quarantine carries a null user and no contact, so it maps to no flow.
const MAPPABLE_EVENTS = EVENT_NAMES.filter(
  (n): n is EventName => n !== 'unknown_payment_quarantined',
);

const { t } = useI18n();
const store = useSinksStore();

const enabled = ref(false);
const token = ref('');
const flowMap = ref<SinkFlowMap>({});

const hasToken = computed(() => store.sink?.auth.hasToken ?? false);
const selectorsEnabled = computed(() => hasToken.value && !store.flowsError);

const flowOptions = computed(() =>
  store.flows.map((f) => ({ value: f.id, label: `${f.name} (${f.botName})` })),
);

// Reset the editable form whenever the loaded sink changes; the token field is
// write-only and never pre-filled from the stored secret.
watch(
  () => store.sink,
  (sink) => {
    enabled.value = sink?.enabled ?? false;
    token.value = '';
    flowMap.value = { ...(sink?.config.flows ?? {}) };
  },
  { immediate: true },
);

onMounted(() => {
  void store.load();
});

function flowValue(event: EventName): string {
  return flowMap.value[event] ?? '';
}

function setFlow(event: EventName, id: string): void {
  flowMap.value = { ...flowMap.value, [event]: id };
}

// A stored flow id absent from the fetched list — the flow was deleted upstream.
function isMissingFlow(event: EventName): boolean {
  const id = flowMap.value[event];
  return id !== undefined && id !== '' && !store.flows.some((f) => f.id === id);
}

function buildFlows(): SinkFlowMap {
  const out: Partial<Record<EventName, string>> = {};
  for (const event of MAPPABLE_EVENTS) {
    const id = flowMap.value[event];
    if (id !== undefined && id !== '') out[event] = id;
  }
  return out;
}

function buildPatch(): UpdateSinkRequest {
  return {
    enabled: enabled.value,
    ...(token.value
      ? { auth: { kind: AuthKind.Bearer, token: token.value } }
      : {}),
    config: { flows: buildFlows() },
  };
}

async function onSave(): Promise<void> {
  const ok = await store.save(buildPatch());
  if (ok) token.value = '';
}
</script>

<template>
  <div class="sinks-page">
    <BasePanel :title="t('sinks.title')">
      <div v-if="store.loading" class="state-center"><BaseSpinner /></div>
      <template v-else>
        <div class="form-field">
          <label class="form-label">{{ t('sinks.enabled') }}</label>
          <label class="toggle">
            <input v-model="enabled" type="checkbox" class="toggle__input" />
            <span class="toggle__text">
              {{ enabled ? t('sinks.on') : t('sinks.off') }}
            </span>
          </label>
        </div>

        <div class="form-field">
          <label class="form-label">{{ t('sinks.token') }}</label>
          <p v-if="hasToken" class="form-hint">{{ t('sinks.tokenSet') }}</p>
          <BaseInput
            v-model="token"
            type="password"
            :placeholder="
              hasToken ? t('sinks.tokenReplace') : t('sinks.tokenEnter')
            "
          />
        </div>

        <p v-if="store.flowsError" class="state-error">
          {{ t('sinks.tokenCheck') }}
        </p>
        <p v-else-if="!hasToken" class="form-hint">
          {{ t('sinks.tokenFirst') }}
        </p>

        <div class="flows">
          <span class="flows__title">{{ t('sinks.flows') }}</span>
          <div v-for="event in MAPPABLE_EVENTS" :key="event" class="form-field">
            <label class="form-label">{{ t(`sinks.events.${event}`) }}</label>
            <BaseCombobox
              :model-value="flowValue(event)"
              :options="flowOptions"
              :disabled="!selectorsEnabled"
              :placeholder="t('sinks.flowPlaceholder')"
              @update:model-value="setFlow(event, $event)"
            >
              <template #empty>{{ t('sinks.noFlows') }}</template>
            </BaseCombobox>
            <p v-if="isMissingFlow(event)" class="form-warn">
              {{ t('sinks.flowNotFound', { id: flowValue(event) }) }}
            </p>
          </div>
        </div>

        <p v-if="store.error && !store.flowsError" class="state-error">
          {{ store.error }}
        </p>
        <BaseButton
          :label="t('common.save')"
          :loading="store.saving"
          @click="onSave"
        />
      </template>
    </BasePanel>
  </div>
</template>

<style scoped>
.sinks-page {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.state-center {
  text-align: center;
  padding: 32px 0;
}
.state-error {
  color: var(--red);
  padding: 4px 0;
  font-size: 13px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 16px;
}
.form-label {
  color: var(--dim);
  font-size: 12px;
}
.form-hint {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
}
.form-warn {
  color: var(--amber);
  font-size: 12px;
  margin: 0;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.toggle__input {
  accent-color: var(--green);
  width: 16px;
  height: 16px;
}
.toggle__text {
  color: var(--text);
  font-size: 13px;
}

.flows {
  margin-bottom: 8px;
}
.flows__title {
  display: block;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  margin-bottom: 12px;
}
</style>
