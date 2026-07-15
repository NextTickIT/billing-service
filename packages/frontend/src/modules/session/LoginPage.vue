<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from './store.js';
import BasePanel from '../../components/BasePanel.vue';
import BaseInput from '../../components/BaseInput.vue';
import BaseButton from '../../components/BaseButton.vue';

const { t } = useI18n();
const router = useRouter();
const store = useSessionStore();

const username = ref('');
const password = ref('');

async function onSubmit(): Promise<void> {
  const ok = await store.login(username.value, password.value);
  if (ok) await router.push('/operator/payments');
}
</script>

<template>
  <div class="login-wrap">
    <BasePanel :title="t('session.loginTitle')">
      <form class="login-form" @submit.prevent="onSubmit">
        <div class="login-field">
          <label class="login-label">{{ t('session.loginLabel') }}</label>
          <BaseInput
            v-model="username"
            :placeholder="t('session.loginLabel')"
            :disabled="store.loading"
          />
        </div>
        <div class="login-field">
          <label class="login-label">{{ t('session.passwordLabel') }}</label>
          <BaseInput
            v-model="password"
            type="password"
            :placeholder="t('session.passwordLabel')"
            :disabled="store.loading"
          />
        </div>
        <p v-if="store.error" class="login-error">
          {{ t('session.loginError') }}
        </p>
        <BaseButton
          :label="t('session.loginButton')"
          :loading="store.loading"
          @click="onSubmit"
        />
      </form>
    </BasePanel>
  </div>
</template>

<style scoped>
.login-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 20px;
}

.login-wrap > * {
  width: 100%;
  max-width: 400px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.login-label {
  color: var(--dim);
  font-size: 12px;
}

.login-error {
  color: var(--red);
  font-size: 13px;
}
</style>
