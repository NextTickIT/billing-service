import '../styles/index.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from '../router/index.js';
import { i18n } from '../i18n/index.js';
import { initTheme } from './theme.js';

initTheme();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(i18n);
app.mount('#app');
