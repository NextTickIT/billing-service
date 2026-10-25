import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

import { i18n } from '@/i18n/index.js';
import LoginPage from '@/modules/session/LoginPage.vue';
import { operatorRoutes } from '@/modules/session/routes.js';

// Tier 3, page/UX: the real page with its real store, i18n and router; only the
// network is faked. `i18n/index.ts` picks its locale at import time, and imports
// are hoisted, so the language must be fixed in a hoisted block.
vi.hoisted(() => {
  localStorage.setItem('lang', 'en');
});

// The real login route, plus a stand-in for the page it opens: the real payments
// page is lazy-loaded and would race the assertions without adding anything here.
const routes = [
  ...operatorRoutes.filter((route) => route.path === '/operator/login'),
  {
    path: '/operator/payments',
    component: { render: () => h('p', 'payments') },
  },
];

// A tiny page object: tests speak in user actions (sign in, read the page), not
// in selectors, so a markup change touches one place.
async function renderLogin() {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/operator/login');
  const wrapper = mount(LoginPage, {
    global: { plugins: [createPinia(), i18n, router] },
  });
  return {
    path: () => router.currentRoute.value.path,
    text: () => wrapper.text(),
    signIn: async (login: string, password: string): Promise<void> => {
      await wrapper.get('input[type="text"]').setValue(login);
      await wrapper.get('input[type="password"]').setValue(password);
      await wrapper.get('button.btn').trigger('click');
      await flushPromises();
    },
  };
}

function serverResponds(status: number) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response('{}', { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem('operator_authed');
});

describe('LoginPage', () => {
  // Green here, red in a real browser: on a 401 `apiFetch` sets
  // `location.href`, which happy-dom does not turn into a reload that wipes the
  // error. e2e/login.spec.ts catches it; this is what the browser tier is for.
  it('shows the error and stays on the page for wrong credentials', async () => {
    serverResponds(401);
    const page = await renderLogin();
    await page.signIn('operator', 'wrong');
    expect(page.text()).toContain('Invalid credentials.');
    expect(page.path()).toBe('/operator/login');
  });

  it('marks the session and opens payments on success', async () => {
    serverResponds(201);
    const page = await renderLogin();
    await page.signIn('operator', 'secret');
    expect(localStorage.getItem('operator_authed')).toBe('1');
    expect(page.path()).toBe('/operator/payments');
  });

  it('posts the typed credentials as { login, password }', async () => {
    const fetchMock = serverResponds(201);
    const page = await renderLogin();
    await page.signIn('operator', 'secret');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ login: 'operator', password: 'secret' }),
      }),
    );
  });
});
