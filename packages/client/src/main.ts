import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';
// vue-flow 全局样式（不可 scoped）
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import App from './App.vue';
import { router } from './router';

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'light',
    themes: {
      light: {
        colors: {
          primary: '#1565C0',
          secondary: '#1A237E',
          accent: '#42A5F5',
          surface: '#FFFFFF',
          background: '#F5F7FA',
          error: '#EF5350',
          info: '#29B6F6',
          success: '#66BB6A',
          warning: '#FFA726',
        },
      },
    },
  },
});

const app = createApp(App);
app.use(vuetify);
app.use(router);
app.mount('#app');
