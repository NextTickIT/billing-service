<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { CheckoutSessionStatus } from '@billing-service/shared';
import { getCheckoutSession } from './api.js';
import { isNetworkError } from '@/infra/errors.js';
import BaseSpinner from '@/components/BaseSpinner.vue';
import BasePanel from '@/components/BasePanel.vue';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30000;

type ReturnState = 'polling' | 'confirmed' | 'timeout' | 'declined';

const { t } = useI18n();
const route = useRoute();
const id = route.params['id'] as string;

const state = ref<ReturnState>('polling');
let timer: ReturnType<typeof setInterval> | null = null;
let elapsed = 0;

async function poll(): Promise<void> {
  try {
    const session = await getCheckoutSession(id);
    if (session.status === CheckoutSessionStatus.Completed) {
      state.value = 'confirmed';
      stopPolling();
    } else if (session.status === CheckoutSessionStatus.Expired) {
      state.value = 'declined';
      stopPolling();
    }
  } catch (err) {
    // A transient network blip is expected while polling — keep going. Any
    // other error is a real fault and must surface, not be swallowed.
    if (!isNetworkError(err)) throw err;
  }
  elapsed += POLL_INTERVAL_MS;
  if (elapsed >= POLL_TIMEOUT_MS && state.value === 'polling') {
    state.value = 'timeout';
    stopPolling();
  }
}

function stopPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

onMounted(() => {
  void poll();
  timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
});

onUnmounted(stopPolling);
</script>

<template>
  <div class="return-wrap">
    <BasePanel :title="t('checkout.title')">
      <div v-if="state === 'polling'" class="return__center">
        <BaseSpinner />
        <p class="return__msg return__msg--dim">{{ t('checkout.processing') }}</p>
      </div>
      <div v-else-if="state === 'confirmed'" class="return__msg return__msg--ok">
        {{ t('checkout.confirmed') }}
      </div>
      <div v-else-if="state === 'timeout'" class="return__msg return__msg--warn">
        {{ t('checkout.confirmLater') }}
      </div>
      <div v-else-if="state === 'declined'" class="return__msg return__msg--error">
        {{ t('checkout.declined') }}
      </div>
    </BasePanel>
  </div>
</template>

<style scoped>
.return-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 20px;
}

.return-wrap > * {
  width: 100%;
  max-width: 480px;
}

.return__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
}

.return__msg {
  padding: 12px 0;
  font-size: 14px;
}

.return__msg--dim { color: var(--dim); }
.return__msg--ok { color: var(--green); }
.return__msg--warn { color: var(--amber); }
.return__msg--error { color: var(--red); }
</style>
